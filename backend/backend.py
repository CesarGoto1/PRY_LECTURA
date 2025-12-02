import os
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
from psycopg2 import pool, extras
import bcrypt

log = logging.getLogger("uvicorn.error")

app = FastAPI()

# Permitir CORS (frontend)
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

# Modelo completo con métricas científicas
class FatigueResult(BaseModel):
    usuario_id: int
    tipo_medicion: str  # "inicial" o "final"
    sebr: float         # Parpadeos por minuto
    perclos: float      # % ojos cerrados
    pct_incompletos: float
    tiempo_cierre: float
    num_bostezos: int
    velocidad_ocular: float
    nivel_subjetivo: int
    es_fatiga: bool

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
    except Exception:
        log.exception("Error conectando a PostgreSQL")
        raise

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

# --- ENDPOINTS ---

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

        cur.execute(
            """
            INSERT INTO usuarios (nombre, apellido, correo, contrasena, rol_id)
            VALUES (%s, %s, %s, %s, 2)
            RETURNING id
            """,
            (data.nombre, data.apellido, data.correo, hashed_pw.decode("utf-8"))
        )
        conn.commit()
        return {"mensaje": "Usuario registrado correctamente"}
    except Exception as e:
        log.exception("Error registro")
        raise HTTPException(status_code=500, detail="Error servidor")
    finally:
        if cur: cur.close()
        if conn: _put_conn_back(conn)

@app.post("/login")
def login_user(data: Login):
    conn = None
    cur = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)

        cur.execute("""
            SELECT u.id, u.nombre, u.apellido, u.correo, u.contrasena,
                r.nombre AS rol_nombre, u.rol_id
            FROM usuarios u
            INNER JOIN roles r ON r.id = u.rol_id
            WHERE correo = %s
        """, (data.correo,))

        user = cur.fetchone()
        if not user or not bcrypt.checkpw(data.contrasena.encode("utf-8"), user["contrasena"].encode("utf-8")):
            raise HTTPException(status_code=401, detail="Credenciales incorrectas")

        cur.execute("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = %s", (user["id"],))
        conn.commit()

        return {
            "mensaje": "Login exitoso",
            "usuario": {
                "id": user["id"],
                "nombre": user["nombre"],
                "apellido": user["apellido"],
                "correo": user["correo"],
                "rol_id": user["rol_id"],
                "rol": user["rol_nombre"]
            }
        }
    except Exception:
        log.exception("Error login")
        raise HTTPException(status_code=500, detail="Error interno")
    finally:
        if cur: cur.close()
        if conn: _put_conn_back(conn)

# NUEVO ENDPOINT PARA GUARDAR FATIGA
@app.post("/save-fatigue")
def save_fatigue(data: FatigueResult):
    conn = None
    try:
        conn = _get_conn_from_pool()
        cur = conn.cursor(cursor_factory=extras.RealDictCursor)
        
        # 1. Buscar Sesión Activa (o crear una)
        cur.execute("""
            SELECT id FROM sesiones 
            WHERE usuario_id = %s AND fecha_fin IS NULL 
            ORDER BY id DESC LIMIT 1
        """, (data.usuario_id,))
        
        row = cur.fetchone()
        if row:
            sesion_id = row['id']
        else:
            cur.execute("""
                INSERT INTO sesiones (usuario_id, fecha_inicio)
                VALUES (%s, NOW()) RETURNING id
            """, (data.usuario_id,))
            sesion_id = cur.fetchone()['id']

        # 2. Determinar Tabla (Inicial vs Final)
        tabla = "medicion_inicial" if data.tipo_medicion == "inicial" else "medicion_final"
        
        # Mapeo de estado a valores de DB
        estado_txt = "FATIGA" if data.es_fatiga else "NORMAL"
        nivel_val = 1 if data.es_fatiga else 0

        query = f"""
            INSERT INTO {tabla} 
            (sesion_id, parpadeos, perclos, pct_incompletos, tiempo_cierre, 
             num_bostezos, velocidad_ocular, nivel_subjetivo, nivel_fatiga, estado_fatiga, ear_promedio)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0)
        """

        cur.execute(query, (
            sesion_id, data.sebr, data.perclos, data.pct_incompletos,
            data.tiempo_cierre, data.num_bostezos, data.velocidad_ocular,
            data.nivel_subjetivo, nivel_val, estado_txt
        ))

        # Si es la medición final, cerramos la sesión
        if data.tipo_medicion == "final":
            cur.execute("UPDATE sesiones SET fecha_fin = NOW(), actividades_completadas = true WHERE id = %s", (sesion_id,))

        conn.commit()
        return {"mensaje": f"Datos guardados en {tabla}"}

    except Exception as e:
        log.exception("Error guardando fatiga")
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn: _put_conn_back(conn)