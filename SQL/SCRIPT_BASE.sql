-- 1. Configuraciones iniciales
SET client_encoding = 'UTF8';
SET standard_conforming_strings = 'on';
SELECT pg_catalog.set_config('search_path', '', false);

-- 2. Creación de la base de datos (Opcional si ya estás conectado a la BD)
-- DROP DATABASE IF EXISTS pry_lectura;
-- CREATE DATABASE pry_lectura WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'Spanish_Ecuador.1252';
-- \c pry_lectura; -- Conéctate a la nueva BD si es necesario

-- 3. Creación de Tablas, Secuencias y PKS
--------------------------------------------------------------------------------

-- Tabla roles
CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.roles (
    id integer NOT NULL DEFAULT nextval('public.roles_id_seq'::regclass),
    nombre character varying(50) NOT NULL
);

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;
ALTER TABLE ONLY public.roles ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.roles ADD CONSTRAINT roles_nombre_key UNIQUE (nombre);

-- Tabla usuarios
CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.usuarios (
    id integer NOT NULL DEFAULT nextval('public.usuarios_id_seq'::regclass),
    nombre text NOT NULL,
    apellido text NOT NULL,
    correo text NOT NULL,
    contrasena text NOT NULL,
    rol_id integer,
    creado_en timestamp without time zone DEFAULT now(),
    ultimo_acceso timestamp without time zone
);

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;
ALTER TABLE ONLY public.usuarios ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.usuarios ADD CONSTRAINT usuarios_correo_key UNIQUE (correo);

-- Tabla sesiones
CREATE SEQUENCE public.sesiones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.sesiones (
    id integer NOT NULL DEFAULT nextval('public.sesiones_id_seq'::regclass),
    usuario_id integer,
    fecha_inicio timestamp without time zone DEFAULT now(),
    fecha_fin timestamp without time zone,
    actividades_completadas boolean DEFAULT false
);

ALTER SEQUENCE public.sesiones_id_seq OWNED BY public.sesiones.id;
ALTER TABLE ONLY public.sesiones ADD CONSTRAINT sesiones_pkey PRIMARY KEY (id);

-- Tabla mediciones
CREATE SEQUENCE public.mediciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.mediciones (
    id integer NOT NULL DEFAULT nextval('public.mediciones_id_seq'::regclass),
    sesion_id integer,
    etapa character varying(20) NOT NULL,
    perclos numeric(5,2),
    parpadeos integer,
    ear_promedio numeric(10,4),
    pct_incompletos numeric(5,2),
    tiempo_cierre numeric(5,2),
    num_bostezos integer,
    velocidad_ocular numeric(10,2),
    nivel_subjetivo integer,
    nivel_fatiga integer,
    estado_fatiga character varying(50),
    fecha timestamp without time zone DEFAULT now(),
    CONSTRAINT mediciones_etapa_check CHECK (((etapa)::text = ANY ((ARRAY['INICIAL'::character varying, 'FINAL'::character varying])::text[])))
);

ALTER SEQUENCE public.mediciones_id_seq OWNED BY public.mediciones.id;
ALTER TABLE ONLY public.mediciones ADD CONSTRAINT mediciones_pkey PRIMARY KEY (id);

-- Tabla comparaciones
CREATE SEQUENCE public.comparaciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.comparaciones (
    id integer NOT NULL DEFAULT nextval('public.comparaciones_id_seq'::regclass),
    sesion_id integer NOT NULL,
    dif_perclos numeric(5,2),
    dif_parpadeo integer,
    porcentaje_reduccion numeric(5,2),
    fecha_calculo timestamp without time zone DEFAULT now()
);

ALTER SEQUENCE public.comparaciones_id_seq OWNED BY public.comparaciones.id;
ALTER TABLE ONLY public.comparaciones ADD CONSTRAINT comparaciones_pkey PRIMARY KEY (id);

-- Tabla diagnosticos_ia
CREATE SEQUENCE public.diagnosticos_ia_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.diagnosticos_ia (
    id integer NOT NULL DEFAULT nextval('public.diagnosticos_ia_id_seq'::regclass),
    sesion_id integer NOT NULL,
    diagnostico_json jsonb NOT NULL,
    fecha_creacion timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER SEQUENCE public.diagnosticos_ia_id_seq OWNED BY public.diagnosticos_ia.id;
ALTER TABLE ONLY public.diagnosticos_ia ADD CONSTRAINT diagnosticos_ia_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.diagnosticos_ia ADD CONSTRAINT diagnosticos_ia_sesion_id_key UNIQUE (sesion_id);


-- 4. Inserción de Datos Iniciales
--------------------------------------------------------------------------------

INSERT INTO public.roles (id, nombre) VALUES (1, 'Administrador');
INSERT INTO public.roles (id, nombre) VALUES (2, 'Usuario');
SELECT pg_catalog.setval('public.roles_id_seq', 2, true);

-- Usuario inicial: admin@admin.com con el rol de Administrador (id=1)
-- Se asume que 'password_hashed' es la contraseña hasheada.
INSERT INTO public.usuarios ( nombre, apellido, correo, contrasena, rol_id)
VALUES('Admin', 'Principal', 'admin@admin.com', '$2b$12$5ymgdz8lADZMrCAjp68b4eBr8EAt2tVP4U0hzeqrYTQ2cu/h4rSt2', 1);
SELECT pg_catalog.setval('public.usuarios_id_seq', 1, true);

-- 5. Creación de Función y Trigger
--------------------------------------------------------------------------------

-- Función para procesar la comparación automática
CREATE OR REPLACE FUNCTION public.procesar_comparacion_automatica()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_perclos_ini NUMERIC;
    v_parp_ini INTEGER;
    v_dif_p NUMERIC;
    v_dif_b INTEGER;
    v_pct NUMERIC;
BEGIN
    -- Solo se activa cuando se guarda la medición FINAL
    IF NEW.etapa = 'FINAL' THEN
        -- Buscar la medición INICIAL de esta misma sesión
        SELECT perclos, parpadeos
        INTO v_perclos_ini, v_parp_ini
        FROM mediciones
        WHERE sesion_id = NEW.sesion_id AND etapa = 'INICIAL';

        -- Si existe la inicial, calculamos
        IF FOUND THEN
            -- Calcular Diferencias
            v_dif_p := v_perclos_ini - NEW.perclos;      -- Positivo = Fatiga bajó (Menos PERCLOS)
            v_dif_b := NEW.parpadeos - v_parp_ini;      -- Positivo = Parpadeo aumentó

            -- Calcular Porcentaje de Reducción ((Dif / Inicial) * 100)
            IF v_perclos_ini > 0 THEN
                v_pct := (v_dif_p / v_perclos_ini) * 100.0;
            ELSE
                v_pct := 0;
            END IF;

            -- Guardar automáticamente en la tabla comparaciones
            INSERT INTO comparaciones (sesion_id, dif_perclos, dif_parpadeo, porcentaje_reduccion)
            VALUES (NEW.sesion_id, v_dif_p, v_dif_b, ROUND(v_pct, 2));
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Trigger para ejecutar la función después de insertar en mediciones
CREATE TRIGGER trg_generar_comparacion
AFTER INSERT ON public.mediciones
FOR EACH ROW
EXECUTE FUNCTION public.procesar_comparacion_automatica();

-- 6. Creación de Foreign Keys (Restricciones de Integridad)
--------------------------------------------------------------------------------

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_rol_id_fkey FOREIGN KEY (rol_id) REFERENCES public.roles(id);

ALTER TABLE ONLY public.sesiones
    ADD CONSTRAINT sesiones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mediciones
    ADD CONSTRAINT mediciones_sesion_id_fkey FOREIGN KEY (sesion_id) REFERENCES public.sesiones(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.comparaciones
    ADD CONSTRAINT comparaciones_sesion_id_fkey FOREIGN KEY (sesion_id) REFERENCES public.sesiones(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.diagnosticos_ia
    ADD CONSTRAINT diagnosticos_ia_sesion_id_fkey FOREIGN KEY (sesion_id) REFERENCES public.sesiones(id) ON DELETE CASCADE;
    