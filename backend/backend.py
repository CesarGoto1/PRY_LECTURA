import os
import logging
from fastapi import FastAPI, HTTPException
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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
        cur.execute("SELECT 1 FROM usuarios WHERE correo = %s", (data.correo,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="El correo ya está registrado")
        hashed_pw = bcrypt.hashpw(data.contrasena.encode("utf-8"), bcrypt.gensalt())
        cur.execute("""
            INSERT INTO usuarios (nombre, apellido, correo, contrasena, rol_id)
            VALUES (%s, %s, %s, %s, 2) RETURNING id
            """, (data.nombre, data.apellido, data.correo, hashed_pw.decode("utf-8")))
        conn.commit()
        return {"mensaje": "Usuario registrado correctamente"}
    except Exception as e:
        if conn: conn.rollback()
        raise HTTPException(status_code=500, detail="Error servidor")
    finally:
        if conn: _put_conn_back(conn)

@app.post("/login")
def login_user(data: Login):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)
        cur.execute("""
            SELECT u.id, u.nombre, u.apellido, u.correo, u.contrasena, r.nombre AS rol_nombre, u.rol_id
            FROM usuarios u INNER JOIN roles r ON r.id = u.rol_id WHERE correo = %s
        """, (data.correo,))
        user = cur.fetchone()
        if not user or not bcrypt.checkpw(data.contrasena.encode("utf-8"), user["contrasena"].encode("utf-8")):
            raise HTTPException(status_code=401, detail="Credenciales incorrectas")
        cur.execute("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = %s", (user["id"],))
        conn.commit()
        return {"mensaje": "Login exitoso", "usuario": {"id": user["id"], "nombre": user["nombre"], "apellido": user["apellido"], "rol": user["rol_nombre"]}}
    except Exception:
        if conn: conn.rollback()
        raise HTTPException(status_code=500, detail="Error interno")
    finally:
        if conn: _put_conn_back(conn)

# --- ENDPOINTS DATOS ---

@app.post("/save-fatigue")
def save_fatigue(data: FatigueResult):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)
        
        # 1. Buscar sesión activa
        cur.execute("""
            SELECT id FROM sesiones WHERE usuario_id = %s AND fecha_fin IS NULL ORDER BY id DESC LIMIT 1
        """, (data.usuario_id,))
        row = cur.fetchone()
        
        if row:
            sesion_id = row['id']
        else:
            cur.execute("INSERT INTO sesiones (usuario_id, fecha_inicio) VALUES (%s, NOW()) RETURNING id", (data.usuario_id,))
            sesion_id = cur.fetchone()['id']

        etapa_db = "INICIAL" if data.tipo_medicion.lower() == "inicial" else "FINAL"
        estado_txt = "FATIGA" if data.es_fatiga else "NORMAL"
        nivel_val = 1 if data.es_fatiga else 0

        # 2. Insertar medición (El Trigger en BD llenará 'comparaciones' automáticamente si es FINAL)
        query = """
            INSERT INTO mediciones (sesion_id, etapa, parpadeos, perclos, pct_incompletos, tiempo_cierre, num_bostezos, velocidad_ocular, nivel_subjetivo, nivel_fatiga, estado_fatiga, ear_promedio)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0)
        """
        cur.execute(query, (sesion_id, etapa_db, data.sebr, data.perclos, data.pct_incompletos, data.tiempo_cierre, data.num_bostezos, data.velocidad_ocular, data.nivel_subjetivo, nivel_val, estado_txt))

        # 3. Cerrar sesión si es final
        if etapa_db == "FINAL":
            cur.execute("UPDATE sesiones SET fecha_fin = NOW(), actividades_completadas = true WHERE id = %s", (sesion_id,))

        conn.commit()
        return {"mensaje": f"Datos guardados exitosamente como {etapa_db}"}
    except Exception as e:
        if conn: conn.rollback()
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
        
        # Consulta limpia usando JOIN a comparaciones (porque sabemos que existen datos)
        query = """
            SELECT 
                s.id as sesion_id,
                TO_CHAR(s.fecha_inicio, 'DD/MM/YYYY HH24:MI') as fecha,
                c.porcentaje_reduccion,
                m_ini.perclos as inicial,
                m_fin.perclos as final
            FROM sesiones s
            JOIN comparaciones c ON c.sesion_id = s.id
            JOIN mediciones m_ini ON m_ini.sesion_id = s.id AND m_ini.etapa = 'INICIAL'
            JOIN mediciones m_fin ON m_fin.sesion_id = s.id AND m_fin.etapa = 'FINAL'
            WHERE s.usuario_id = %s
            ORDER BY s.fecha_inicio DESC
        """
        cur.execute(query, (data.usuario_id,))
        historial = cur.fetchall()
        
        # Si no hay datos, retornamos flag 'empty'
        if not historial:
            return {"empty": True}

        # Calcular promedios para las tarjetas
        count = len(historial)
        total_ini = sum(float(h['inicial']) for h in historial)
        total_fin = sum(float(h['final']) for h in historial)
        total_red = sum(float(h['porcentaje_reduccion']) for h in historial)

        promedios = {
            "inicial": round(total_ini / count, 1),
            "final": round(total_fin / count, 1),
            "reduccion": round(total_red / count, 1)
        }

        return {"empty": False, "historial": historial, "promedios": promedios}
    except Exception as e:
        log.exception("Error historial")
        return {"error": str(e)}
    finally:
        if conn: _put_conn_back(conn)

# --- ENDPOINT: DETALLE PARA GRÁFICOS (SIN CÁLCULOS) ---
@app.post("/get-session-details")
def get_session_details(data: DetailRequest):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)
        
        # Trae las dos mediciones (INICIAL y FINAL) de la sesión
        # Esto es lo que necesitas para pintar las barras en el frontend
        cur.execute("""
            SELECT etapa, perclos, parpadeos, velocidad_ocular 
            FROM mediciones 
            WHERE sesion_id = %s
        """, (data.sesion_id,))
        
        filas = cur.fetchall()
        
        # Convertir a formato fácil para JS: { "INICIAL": {...}, "FINAL": {...} }
        datos = {}
        for fila in filas:
            datos[fila['etapa']] = fila
            
        return datos

    except Exception as e:
        log.exception("Error detalle")
        return {"error": str(e)}
    finally:
        if conn: _put_conn_back(conn)
