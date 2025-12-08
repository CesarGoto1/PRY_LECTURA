// ========================================================
//  PROTEGER RUTA SOLO ADMIN
// ========================================================
protegerRuta("admin");

const userLog = obtenerUsuarioSimple();
console.log("Admin logueado:", userLog);

// Elementos del DOM
const tabla = document.getElementById("tablaUsuarios");
const totalEstudiantesEl = document.getElementById("totalEstudiantes");
const fatigaInicialPromEl = document.getElementById("fatigaInicialProm");
const reduccionPromEl = document.getElementById("reduccionProm");

let graficoFatiga = null;
let graficoRadar = null;

// ========================================================
//  Cargar sesiones globales del backend
// ========================================================
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const resp = await fetch("http://localhost:8000/admin/all-sessions");
        const data = await resp.json();

        if (!data.ok) {
            console.error(data.error);
            alert("No se pudieron cargar los datos.");
            return;
        }

        console.log("Sesiones recibidas:", data);
        llenarTabla(data.sesiones);
        llenarMetricas(data.sesiones);
        generarGraficos(data.sesiones);

    } catch (err) {
        console.error(err);
        alert("Error al conectar con el servidor.");
    }
});

// ========================================================
//  Llenar tabla de usuarios
// ========================================================
function llenarTabla(sesiones) {
    tabla.innerHTML = "";

    sesiones.forEach(s => {
        const color = s.porcentaje_reduccion > 0 ? "text-success" : "text-danger";

        tabla.innerHTML += `
            <tr>
                <td>${s.estudiante}</td>
                <td>${s.fecha}</td>
                <td>${s.inicial}%</td>
                <td>${s.final}%</td>
                <td class="${color} fw-bold">${s.porcentaje_reduccion}%</td>
                <td>
                    <button class="btn btn-outline-primary btn-sm"
                        onclick="verDetalle(${s.sesion_id})">
                        <i class="fas fa-eye"></i> Ver
                    </button>
                </td>
            </tr>
        `;
    });
}

// ========================================================
//  Acción para ver detalle
// ========================================================
function verDetalle(id) {
    window.location.href = `details.html?sesion=${id}`;
}

// ========================================================
//  Cálculo de métricas globales
// ========================================================
function llenarMetricas(sesiones) {
    const estudiantesUnicos = new Set(sesiones.map(s => s.estudiante));
    totalEstudiantesEl.textContent = estudiantesUnicos.size;

    const avgIni = promedio(sesiones.map(s => s.inicial));
    const avgFin = promedio(sesiones.map(s => s.final));
    const avgRed = promedio(sesiones.map(s => s.porcentaje_reduccion));

    fatigaInicialPromEl.textContent = avgIni + "%";
    reduccionPromEl.textContent = avgRed + "%";
}

function promedio(arr) {
    if (arr.length === 0) return 0;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// ========================================================
//  Gráficos globales
// ========================================================
function generarGraficos(sesiones) {
    const promedioIni = promedio(sesiones.map(s => s.inicial));
    const promedioFin = promedio(sesiones.map(s => s.final));

    // --- Gráfico de Barras ---
    const ctx1 = document.getElementById("graficoFatiga").getContext("2d");

    if (graficoFatiga) graficoFatiga.destroy();

    graficoFatiga = new Chart(ctx1, {
        type: "bar",
        data: {
            labels: ["Inicial", "Final"],
            datasets: [{
                label: "Promedio (%)",
                data: [promedioIni, promedioFin],
                backgroundColor: ["#FFC300", "#4DA3FF"]
            }]
        }
    });

    // --- Gráfico Radar (valores referencias) ---
    const ctx2 = document.getElementById("graficoRadar").getContext("2d");

    if (graficoRadar) graficoRadar.destroy();

    graficoRadar = new Chart(ctx2, {
        type: "radar",
        data: {
            labels: ["EAR", "Parpadeos/min", "Mirada desviada", "Cierre prolongado"],
            datasets: [
                {
                    label: "Inicial",
                    borderWidth: 2,
                    borderColor: "#FF9800",
                    data: [0.21, 10, 20, 12]
                },
                {
                    label: "Final",
                    borderWidth: 2,
                    borderColor: "#4DA3FF",
                    data: [0.28, 15, 12, 5]
                }
            ]
        }
    });
}
