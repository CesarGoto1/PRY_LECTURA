// ========================================================
//  PROTECCIÓN: El usuario debe estar logueado
// ========================================================
function obtenerUsuario() {
    const usuarioStr = localStorage.getItem("usuario");

    if (!usuarioStr) {
        alert("Debes iniciar sesión para continuar.");
        window.location.href = "/templates/login.html";
        throw new Error("Usuario no autenticado");
    }

    return JSON.parse(usuarioStr);
}

const usuario = obtenerUsuario();

// ========================================================
//  FUNCIÓN PARA INICIAR / GUARDAR MEDICIONES
// ========================================================
async function guardarMedicion(tipo, dataFatiga) {
    try {
        const payload = {
            usuario_id: usuario.id,  // <-- AQUÍ SE ARREGLA TODO
            tipo_medicion: tipo,     // "inicial" o "final"
            sebr: dataFatiga.sebr,
            perclos: dataFatiga.perclos,
            pct_incompletos: dataFatiga.pct_incompletos,
            tiempo_cierre: dataFatiga.tiempo_cierre,
            num_bostezos: dataFatiga.num_bostezos,
            velocidad_ocular: dataFatiga.velocidad_ocular,
            nivel_subjetivo: dataFatiga.nivel_subjetivo,
            es_fatiga: dataFatiga.es_fatiga
        };

        const resp = await fetch("http://localhost:8000/save-fatigue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const res = await resp.json();
        console.log("Respuesta del servidor:", res);

        if (!resp.ok) {
            alert("Error al guardar la medición: " + (res.detail || "Error desconocido"));
            return;
        }

        return res;
    } catch (e) {
        console.error("Error en guardarMedicion:", e);
        alert("Error de conexión con el servidor.");
    }
}
