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

class Login(BaseModel):
    correo: str
    contrasena: str

class Register(BaseModel):
    nombre: str
    apellido: str
    correo: str
    contrasena: str

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
        if not app.state.db_pool:
            raise RuntimeError("No se pudo inicializar el pool de conexiones")
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
    if db_pool is None:
        raise HTTPException(status_code=500, detail="Conexión a BD no disponible")
    return db_pool.getconn()

def _put_conn_back(conn):
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool:
        db_pool.putconn(conn)

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

    except HTTPException:
        raise
    except Exception:
        log.exception("Error en /register")
        raise HTTPException(status_code=500, detail="Error interno en servidor")
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

        cur.execute(
            """
            SELECT u.id, u.nombre, u.apellido, u.correo, u.contrasena,
                r.nombre AS rol_nombre, u.rol_id
            FROM usuarios u
            INNER JOIN roles r ON r.id = u.rol_id
            WHERE correo = %s
            """,
            (data.correo,)
        )

        user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="Correo o contraseña incorrectos")

        stored_hash = user["contrasena"]
        if not bcrypt.checkpw(data.contrasena.encode("utf-8"), stored_hash.encode("utf-8")):
            raise HTTPException(status_code=401, detail="Correo o contraseña incorrectos")

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

    except HTTPException:
        raise
    except Exception:
        log.exception("Error en /login")
        raise HTTPException(status_code=500, detail="Error interno del servidor")
    finally:
        if cur: cur.close()
        if conn: _put_conn_back(conn)
