// =====================================================
// DETAILS.JS – DETALLE DE UNA SESIÓN
// =====================================================

// Validación de sesión
function obtenerUsuario() {
    const usuarioStr = localStorage.getItem("usuario");
    if (!usuarioStr) {
        window.location.href = "../login.html";
        throw new Error("Usuario no autenticado");
    }
    return JSON.parse(usuarioStr);
}

const usuario = obtenerUsuario();
if (usuario.rol !== "admin") {
    alert("Acceso denegado.");
    window.location.href = "../usuario/index.html";
}

// Obtener ID desde la URL
const params = new URLSearchParams(window.location.search);
const sesionId = params.get("sesion");

if (!sesionId) {
    alert("ID de sesión no proporcionado.");
    window.location.href = "index.html";
}

// =====================================================
// Cargar datos de la sesión
// =====================================================
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const resp = await fetch("http://localhost:8000/get-session-details", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sesion_id: sesionId })
        });

        const datos = await resp.json();

        if (!datos.INICIAL || !datos.FINAL) {
            alert("Los datos de esta sesión están incompletos.");
            return;
        }

        renderGraficos(datos);
        renderEstado(datos.FINAL.estado_fatiga);

    } catch (err) {
        console.error(err);
        alert("Error cargando los detalles de la sesión.");
    }
});

// =====================================================
// Gráficos de detalle
// =====================================================
function renderGraficos(d) {

    // PERCLOS
    new Chart(document.getElementById("chartPerclos"), {
        type: "bar",
        data: {
            labels: ["Inicial", "Final"],
            datasets: [{
                data: [d.INICIAL.perclos, d.FINAL.perclos],
                backgroundColor: ["#FFC300", "#4DA3FF"],
                borderRadius: 5
            }]
        }
    });

    // PARPADEOS
    new Chart(document.getElementById("chartParpadeos"), {
        type: "line",
        data: {
            labels: ["Inicial", "Final"],
            datasets: [{
                data: [d.INICIAL.parpadeos, d.FINAL.parpadeos],
                borderColor: "#4DA3FF",
                backgroundColor: "rgba(77,163,255,0.2)",
                fill: true,
                tension: 0.3
            }]
        }
    });

    // VELOCIDAD OCULAR
    new Chart(document.getElementById("chartVelocidad"), {
        type: "line",
        data: {
            labels: ["Inicial", "Final"],
            datasets: [{
                data: [d.INICIAL.velocidad_ocular, d.FINAL.velocidad_ocular],
                borderColor: "#FF9800",
                backgroundColor: "rgba(255,152,0,0.2)",
                fill: true,
                tension: 0.3
            }]
        }
    });

    // KSS (Nivel subjetivo)
    new Chart(document.getElementById("chartKSS"), {
        type: "bar",
        data: {
            labels: ["Inicial", "Final"],
            datasets: [{
                data: [d.INICIAL.nivel_subjetivo, d.FINAL.nivel_subjetivo],
                backgroundColor: ["#FFC300", "#4DA3FF"],
                borderRadius: 5
            }]
        }
    });
}

// =====================================================
// Mensaje de estado final
// =====================================================
function renderEstado(estado) {
    const box = document.getElementById("estadoFatiga");

    if (estado.toUpperCase().includes("FATIGA")) {
        box.className = "alert alert-danger";
        box.innerText = "Fatiga detectada en la medición final.";
    } else {
        box.className = "alert alert-success";
        box.innerText = "Estado normal en la medición final.";
    }
}

// =====================================================
// Cerrar sesión
// =====================================================
function cerrarSesion() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "../login.html";
}
