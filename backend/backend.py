import os
import logging
from fastapi import FastAPI, HTTPException
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
import json

import psycopg2
from psycopg2 import pool, extras
import bcrypt

# Configuración de logs
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("uvicorn.error")

app = FastAPI()

# --- CONFIGURACIÓN CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- MODELOS DE DATOS ---
class Login(BaseModel):
    correo: str
    contrasena: str

class Register(BaseModel):
    nombre: str
    apellido: str
    correo: str
    contrasena: str

class FatigueResult(BaseModel):
    usuario_id: int
    tipo_medicion: str
    sebr: float
    perclos: float
    pct_incompletos: float
    tiempo_cierre: float
    num_bostezos: int
    velocidad_ocular: float
    nivel_subjetivo: int
    es_fatiga: bool

class DashboardRequest(BaseModel):
    usuario_id: int

class DetailRequest(BaseModel):
    sesion_id: int

# --- BASE DE DATOS ---
@app.on_event("startup")
def startup():
    try:
        db_config = {
            "host": os.getenv("DB_HOST", "127.0.0.1"),
            "port": int(os.getenv("DB_PORT", "5432")),
            "database": os.getenv("DB_NAME", "pry_lectura"),
            "user": os.getenv("DB_USER", "postgres"),
            "password": os.getenv("DB_PASS", "123"),
        }
        app.state.db_pool = pool.SimpleConnectionPool(1, 10, **db_config)
        log.info("Conexión a base de datos establecida.")
    except Exception as e:
        log.exception("Error conectando a PostgreSQL")
        raise e

@app.on_event("shutdown")
def shutdown():
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool:
        db_pool.closeall()

def _get_conn_from_pool():
    db_pool = getattr(app.state, "db_pool", None)
    if not db_pool:
        raise HTTPException(status_code=500, detail="Conexión BD no disponible")
    return db_pool.getconn()

def _put_conn_back(conn):
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool:
        db_pool.putconn(conn)

# --- ENDPOINTS AUTH ---
@app.post("/register")
def register_user(data: Register):
    conn = None
    cur = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        # Verificar correo único
        cur.execute("SELECT 1 FROM usuarios WHERE correo = %s", (data.correo,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="El correo ya está registrado")

        # Hash de contraseña
        hashed_pw = bcrypt.hashpw(data.contrasena.encode("utf-8"), bcrypt.gensalt())

        cur.execute(
            """
            INSERT INTO usuarios (nombre, apellido, correo, contrasena, rol_id)
            VALUES (%s, %s, %s, %s, 2) RETURNING id
            """,
            (data.nombre, data.apellido, data.correo, hashed_pw.decode("utf-8")),
        )
        conn.commit()
        return {"mensaje": "Usuario registrado correctamente"}
    except Exception:
        log.exception("Error en /register") # Loguear el traceback completo
        if conn:
            conn.rollback()
        raise HTTPException(status_code=500, detail="Error servidor")
    finally:
        if conn:
            _put_conn_back(conn)

@app.post("/login")
def login_user(data: Login):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        cur.execute(
            """
            SELECT u.id, u.nombre, u.apellido, u.correo, u.contrasena,
                   r.nombre AS rol_nombre, u.rol_id
            FROM usuarios u
            INNER JOIN roles r ON r.id = u.rol_id
            WHERE correo = %s
            """,
            (data.correo,),
        )
        user = cur.fetchone()

        if not user or not bcrypt.checkpw(
            data.contrasena.encode("utf-8"), user["contrasena"].encode("utf-8")
        ):
            raise HTTPException(status_code=401, detail="Credenciales incorrectas")

        cur.execute("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = %s", (user["id"],))
        conn.commit()

        return {
            "mensaje": "Login exitoso",
            "usuario": {
                "id": user["id"],
                "nombre": user["nombre"],
                "apellido": user["apellido"],
                "rol": user["rol_nombre"],
            },
        }
    except HTTPException:
        if conn:
            conn.rollback()
        raise
    except Exception:
        if conn:
            conn.rollback()
        raise HTTPException(status_code=500, detail="Error interno")
    finally:
        if conn:
            _put_conn_back(conn)

# --- ENDPOINTS DATOS ---
@app.post("/save-fatigue")
async def save_fatigue(data: FatigueResult):
    conn = None
    mensaje_ui = None
    diagnostico_ia = None
    
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        cur.execute("SELECT id FROM sesiones WHERE usuario_id = %s AND fecha_fin IS NULL ORDER BY id DESC LIMIT 1", (data.usuario_id,))
        row = cur.fetchone()
        if row:
            sesion_id = row["id"]
        else:
            cur.execute("INSERT INTO sesiones (usuario_id, fecha_inicio) VALUES (%s, NOW()) RETURNING id", (data.usuario_id,))
            sesion_id = cur.fetchone()["id"]

        etapa_db = "INICIAL" if data.tipo_medicion.lower() == "inicial" else "FINAL"
        estado_txt = "FATIGA" if data.es_fatiga else "NORMAL"
        nivel_val = 1 if data.es_fatiga else 0

        query = """
            INSERT INTO mediciones (
                sesion_id, etapa, parpadeos, perclos, pct_incompletos,
                tiempo_cierre, num_bostezos, velocidad_ocular,
                nivel_subjetivo, nivel_fatiga, estado_fatiga, ear_promedio
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0)
        """
        cur.execute(query, (
            sesion_id, etapa_db, data.sebr, data.perclos, data.pct_incompletos,
            data.tiempo_cierre, data.num_bostezos, data.velocidad_ocular,
            data.nivel_subjetivo, nivel_val, estado_txt
        ))

        if etapa_db == "FINAL":
            cur.execute("UPDATE sesiones SET fecha_fin = NOW(), actividades_completadas = true WHERE id = %s", (sesion_id,))
            
            cur.execute("SELECT porcentaje_reduccion FROM comparaciones WHERE sesion_id = %s", (sesion_id,))
            row_comp = cur.fetchone()

            if row_comp:
                porcentaje_reduccion = float(row_comp['porcentaje_reduccion'])
                if data.es_fatiga and porcentaje_reduccion > 0:
                    mensaje_ui = f"Diagnóstico: FATIGA PERSISTENTE (Se redujo en un {porcentaje_reduccion}%)"
                elif data.es_fatiga and porcentaje_reduccion <= 0:
                    mensaje_ui = "Diagnóstico: FATIGA DETECTADA (El nivel aumentó o se mantiene)"
                elif not data.es_fatiga and porcentaje_reduccion > 0:
                    mensaje_ui = f"Diagnóstico: RECUPERADO (Mejora del {porcentaje_reduccion}%)"
                else:
                    mensaje_ui = "Diagnóstico: ESTADO NORMAL"

            # --- INICIO: LLAMADA A N8N Y GUARDADO DE DIAGNÓSTICO IA ---
            try:
                n8n_webhook_url = os.getenv("N8N_WEBHOOK_URL", "http://localhost:5678/webhook/visual-fatigue-diagnosis") # URL por defecto para prueba
                if n8n_webhook_url:
                    async with httpx.AsyncClient() as client:
                        response = await client.post(n8n_webhook_url, json=data.dict(), timeout=30)
                        response.raise_for_status()
                        diagnostico_ia = response.json()
                        
                        cur.execute(
                            "INSERT INTO diagnosticos_ia (sesion_id, diagnostico_json) VALUES (%s, %s)",
                            (sesion_id, json.dumps(diagnostico_ia))
                        )
                else:
                    log.warning("N8N_WEBHOOK_URL no está configurada. Saltando diagnóstico de IA.")

            except Exception as e:
                log.error(f"Error al contactar o guardar el diagnóstico de IA: {e}")
            # --- FIN: LLAMADA A N8N ---

        conn.commit()
        
        return {
            "mensaje": f"Datos guardados exitosamente como {etapa_db}",
            "diagnostico_personalizado": mensaje_ui,
            "diagnostico_detallado_ia": diagnostico_ia
        }

    except Exception as e:
        if conn: conn.rollback()
        log.exception("Error en save_fatigue")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn: _put_conn_back(conn)

# --- ENDPOINT: HISTORIAL DIRECTO DE BD ---
@app.post("/get-user-history")
def get_user_history(data: DashboardRequest):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        query = """
            SELECT
                s.id as sesion_id,
                TO_CHAR(s.fecha_inicio, 'DD/MM/YYYY HH24:MI') as fecha,
                c.porcentaje_reduccion,
                m_ini.perclos as inicial,
                m_fin.perclos as final,
                dia.diagnostico_json -- Se añade esta línea
            FROM sesiones s
            LEFT JOIN comparaciones c ON c.sesion_id = s.id
            LEFT JOIN mediciones m_ini ON m_ini.sesion_id = s.id AND m_ini.etapa = 'INICIAL'
            LEFT JOIN mediciones m_fin ON m_fin.sesion_id = s.id AND m_fin.etapa = 'FINAL'
            LEFT JOIN diagnosticos_ia dia ON dia.sesion_id = s.id -- Se añade esta línea
            WHERE s.usuario_id = %s AND s.fecha_fin IS NOT NULL
            ORDER BY s.fecha_inicio DESC
        """
        cur.execute(query, (data.usuario_id,))
        historial = cur.fetchall()

        if not historial:
            return {"empty": True}

        # El cálculo de promedios se mantiene, pero hay que manejar posibles nulos
        count_red = sum(1 for h in historial if h.get("porcentaje_reduccion") is not None)
        total_ini = sum(float(h["inicial"]) for h in historial if h.get("inicial") is not None)
        total_fin = sum(float(h["final"]) for h in historial if h.get("final") is not None)
        total_red = sum(float(h["porcentaje_reduccion"]) for h in historial if h.get("porcentaje_reduccion") is not None)
        
        promedios = {
            "inicial": round(total_ini / len(historial), 1) if historial else 0,
            "final": round(total_fin / len(historial), 1) if historial else 0,
            "reduccion": round(total_red / count_red, 1) if count_red > 0 else 0,
        }

        return {"empty": False, "historial": historial, "promedios": promedios}
    except Exception as e:
        log.exception("Error historial")
        return {"error": str(e)}
    finally:
        if conn:
            _put_conn_back(conn)


# --- ENDPOINT: OBTENER O CREAR DIAGNÓSTICO IA ---
@app.post("/get-or-create-diagnosis")
async def get_or_create_diagnosis(data: DetailRequest):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        # 1. Verificar si ya existe un diagnóstico
        cur.execute("SELECT diagnostico_json FROM diagnosticos_ia WHERE sesion_id = %s", (data.sesion_id,))
        existing_diagnosis = cur.fetchone()
        if existing_diagnosis and existing_diagnosis['diagnostico_json']:
            log.info(f"Devolviendo diagnóstico existente para sesion_id: {data.sesion_id}")
            return existing_diagnosis['diagnostico_json']

        # 2. Si no existe, obtener los datos de ambas mediciones (INICIAL y FINAL)
        log.info(f"No se encontró diagnóstico. Generando uno nuevo para sesion_id: {data.sesion_id}")
        query = """
            SELECT
                m.etapa,
                s.usuario_id,
                m.parpadeos AS sebr,
                m.perclos,
                m.tiempo_cierre,
                m.num_bostezos,
                m.velocidad_ocular,
                m.nivel_subjetivo
            FROM mediciones m
            JOIN sesiones s ON m.sesion_id = s.id
            WHERE m.sesion_id = %s AND (m.etapa = 'INICIAL' OR m.etapa = 'FINAL')
        """
        cur.execute(query, (data.sesion_id,))
        measurements = cur.fetchall()
        
        initial_data = next((m for m in measurements if m['etapa'] == 'INICIAL'), None)
        final_data = next((m for m in measurements if m['etapa'] == 'FINAL'), None)

        if not initial_data or not final_data:
            raise HTTPException(status_code=404, detail="Datos de medición INICIAL o FINAL incompletos para esta sesión.")

        # 3. Construir explícitamente el payload para n8n, convirtiendo el tipo Decimal a float para que sea serializable
        payload_to_n8n = {
            "inicial": {
                "usuario_id": initial_data['usuario_id'],
                "perclos": float(initial_data['perclos']),
                "sebr": float(initial_data['sebr']),
                "num_bostezos": initial_data['num_bostezos'],
                "tiempo_cierre": float(initial_data['tiempo_cierre']),
                "velocidad_ocular": float(initial_data['velocidad_ocular']),
                "nivel_subjetivo": initial_data['nivel_subjetivo']
            },
            "final": {
                "perclos": float(final_data['perclos']),
                "sebr": float(final_data['sebr']),
                "num_bostezos": final_data['num_bostezos'],
                "tiempo_cierre": float(final_data['tiempo_cierre']),
                "velocidad_ocular": float(final_data['velocidad_ocular']),
                "nivel_subjetivo": final_data['nivel_subjetivo']
            }
        }
        log.info(f"Enviando el siguiente payload a n8n: {json.dumps(payload_to_n8n, indent=2)}")

        # 4. Llamar al webhook de n8n
        n8n_webhook_url = os.getenv("N8N_WEBHOOK_URL", "http://localhost:5678/webhook/visual-fatigue-diagnosis")
        if not n8n_webhook_url:
            raise HTTPException(status_code=500, detail="La URL del webhook de N8N no está configurada.")

        diagnostico_ia = None
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(n8n_webhook_url, json=payload_to_n8n, timeout=60)
                response.raise_for_status()
                # n8n puede devolver una lista con un objeto, debemos manejar eso
                responseData = response.json()
                diagnostico_ia = responseData[0]['json'] if isinstance(responseData, list) and responseData and 'json' in responseData[0] else responseData
            except httpx.RequestError as e:
                log.error(f"Error al contactar con n8n: {e}")
                raise HTTPException(status_code=503, detail="El servicio de diagnóstico de IA no está disponible o no respondió a tiempo.")
            except httpx.HTTPStatusError as e:
                log.error(f"Error de estado HTTP de n8n: {e.response.status_code} - {e.response.text}")
                raise HTTPException(status_code=e.response.status_code, detail=f"Error del servicio de IA: {e.response.text}")

        if not diagnostico_ia:
            raise HTTPException(status_code=500, detail="El servicio de IA devolvió una respuesta vacía o inválida.")
        
        log.info("Diagnóstico de IA recibido exitosamente.")

        # 5. Guardar el nuevo diagnóstico en la base de datos
        cur.execute(
            "INSERT INTO diagnosticos_ia (sesion_id, diagnostico_json) VALUES (%s, %s) ON CONFLICT (sesion_id) DO UPDATE SET diagnostico_json = EXCLUDED.diagnostico_json",
            (data.sesion_id, json.dumps(diagnostico_ia))
        )
        conn.commit()
        log.info(f"Diagnóstico para sesion_id: {data.sesion_id} guardado en la BD.")

        return diagnostico_ia

    except HTTPException:
        if conn: conn.rollback()
        raise
    except Exception as e:
        if conn: conn.rollback()
        log.exception("Error crítico en get_or_create_diagnosis")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            _put_conn_back(conn)


# --- ENDPOINT: DETALLE PARA GRÁFICOS ---
@app.post("/get-session-details")
def get_session_details(data: DetailRequest):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        cur.execute(
            """
            SELECT
                etapa,
                perclos,
                parpadeos,
                velocidad_ocular,
                num_bostezos,
                nivel_subjetivo,
                estado_fatiga
            FROM mediciones
            WHERE sesion_id = %s
            """,
            (data.sesion_id,),
        )
        filas = cur.fetchall()

        datos = {}
        for fila in filas:
            datos[fila["etapa"]] = fila

        return datos
    except Exception as e:
        log.exception("Error detalle")
        return {"error": str(e)}
    finally:
        if conn:
            _put_conn_back(conn)

from fastapi import FastAPI
from psycopg2 import extras

@app.get("/admin/all-sessions")
def admin_all_sessions():
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        cur.execute("""
            SELECT 
                s.id AS sesion_id,
                CONCAT(u.nombre, ' ', u.apellido) AS estudiante,
                TO_CHAR(s.fecha_inicio, 'DD/MM/YYYY HH24:MI') AS fecha,
                m_ini.perclos AS inicial,
                m_fin.perclos AS final,
                c.porcentaje_reduccion
            FROM sesiones s
            JOIN usuarios u ON u.id = s.usuario_id
            JOIN comparaciones c ON c.sesion_id = s.id
            JOIN mediciones m_ini ON m_ini.sesion_id = s.id AND m_ini.etapa = 'INICIAL'
            JOIN mediciones m_fin ON m_fin.sesion_id = s.id AND m_fin.etapa = 'FINAL'
            ORDER BY s.fecha_inicio DESC
        """)

        sesiones = cur.fetchall()

        return {"ok": True, "sesiones": sesiones}

    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if conn:
            _put_conn_back(conn)

