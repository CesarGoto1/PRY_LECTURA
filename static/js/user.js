// ========================================================
//  VARIABLES GLOBALES Y CONFIGURACIÓN INICIAL
// ========================================================
let historialData = []; // Variable para guardar los datos del historial
let chartInstance = null;
let chartPerclos = null;
let chartParpadeos = null;

// ========================================================
// 1. Validar el usuario desde LOCALSTORAGE y bienvenida
// ========================================================
function obtenerUsuario() {
    const usuarioStr = localStorage.getItem("usuario");
    if (!usuarioStr) {
        // Redirige si no hay usuario
        window.location.href = "/templates/login.html"; 
        throw new Error("Usuario no autenticado");
    }
    return JSON.parse(usuarioStr);
}

function cerrarSesion() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "/templates/login.html";
}


// ========================================================
// 2. Cargar datos al iniciar la página
// ========================================================
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const usuario = obtenerUsuario();
        const userNameEl = document.getElementById('userName');
        if(userNameEl) userNameEl.innerText = `${usuario.nombre} ${usuario.apellido}`;

        const response = await fetch('http://localhost:8000/get-user-history', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ usuario_id: usuario.id })
        });

        if (!response.ok) throw new Error("Error en el servidor al obtener historial.");

        const data = await response.json();

        const emptyState = document.getElementById('emptyState');
        const dashboardContent = document.getElementById('dashboardContent');

        if (data.empty) {
            if(emptyState) emptyState.style.display = 'block';
            if(dashboardContent) dashboardContent.style.display = 'none';
        } else {
            historialData = data.historial; 
            if(emptyState) emptyState.style.display = 'none';
            if(dashboardContent) dashboardContent.style.display = 'block';
            llenarDashboard(data);
        }

    } catch (error) {
        console.error("Error en DOMContentLoaded:", error);
        // No mostramos alerta aquí para no interrumpir al usuario si el error es de red
        // y ya fue manejado por obtenerUsuario()
    }
});

// ========================================================
// 3. Llenar el dashboard con datos del historial
// ========================================================
function llenarDashboard(data) {
    const avgIni = document.getElementById('avgIni');
    const avgFin = document.getElementById('avgFin');
    const avgRed = document.getElementById('avgRed');

    if (avgIni) avgIni.innerText = (data.promedios.inicial || 0) + "%";
    if (avgFin) avgFin.innerText = (data.promedios.final || 0) + "%";
    if (avgRed) avgRed.innerText = (data.promedios.reduccion || 0) + "%";

    const tbody = document.getElementById('tablaHistorial');
    if(!tbody) return;

    tbody.innerHTML = "";

    data.historial.forEach(sesion => {
        const reduccion = sesion.porcentaje_reduccion || 0;
        const esMejora = reduccion > 0;
        const claseColor = esMejora ? "text-success" : "text-danger";
        const signo = esMejora ? "-" : "+";
        
        const botonDiagnostico = `
            <button 
                class="btn btn-primary btn-sm" 
                onclick="abrirModal(${sesion.sesion_id})">
                <i class="bi bi-robot me-1"></i>Ver Análisis
            </button>`;

        const row = `
            <tr>
                <td>${sesion.fecha}</td>
                <td><span class="badge bg-warning text-dark rounded-pill px-3">${sesion.inicial || 'N/A'}%</span></td>
                <td><span class="badge bg-primary rounded-pill px-3">${sesion.final || 'N/A'}%</span></td>
                <td class="${claseColor} fw-bold">${signo}${Math.abs(reduccion)}%</td>
                <td>${botonDiagnostico}</td>
            </tr>
        `;
        tbody.innerHTML += row;
    });
}

// ========================================================
// 4. Abrir modal y solicitar análisis de IA
// ========================================================
async function abrirModal(sesionId) {
    const modalElement = document.getElementById('detalleModal');
    if (!modalElement) return;
    
    const modal = new bootstrap.Modal(modalElement);
    modal.show();

    const containerIA = document.getElementById('diagnosticoIaContainer');
    const diagnosticoGeneralElem = document.getElementById('iaDiagnosticoGeneral');
    const severidadContainer = document.getElementById('iaSeveridadContainer');
    const parametrosTbody = document.getElementById('iaParametrosTbody');
    const recomendacionesContainer = document.getElementById('iaRecomendacionesGenerales');
    const modalChartsContainer = document.querySelector('#detalleModal .row');

    // 1. Resetear y mostrar estado de carga
    if (containerIA) containerIA.style.display = 'block';
    if (diagnosticoGeneralElem) diagnosticoGeneralElem.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div> Generando análisis de IA...';
    if (severidadContainer) severidadContainer.innerHTML = '';
    if (parametrosTbody) parametrosTbody.innerHTML = '';
    if (recomendacionesContainer) recomendacionesContainer.innerHTML = '';
    
    // Ocultar gráficos mientras cargan
    if(modalChartsContainer) modalChartsContainer.style.display = 'none';

    // 2. Cargar datos de la sesión (gráficos y métricas)
    try {
        const response = await fetch('http://localhost:8000/get-session-details', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ sesion_id: sesionId })
        });

        if (!response.ok) throw new Error('No se pudieron obtener los detalles de la sesión.');
        
        const datos = await response.json();
        if (!datos.INICIAL || !datos.FINAL) throw new Error("Datos incompletos para mostrar detalles");

        llenarMetricasModal(datos);
        crearGraficosModal(datos);
        if(modalChartsContainer) modalChartsContainer.style.display = 'flex';

    } catch (e) {
        console.error("Error al cargar datos de sesión:", e);
        if (diagnosticoGeneralElem) diagnosticoGeneralElem.innerHTML = `<i class="bi bi-exclamation-triangle-fill text-danger me-2"></i>Error: ${e.message}`;
        return; // Detener si los datos base no cargan
    }

    // 3. Solicitar diagnóstico de IA
    try {
        const iaResponse = await fetch('http://localhost:8000/get-or-create-diagnosis', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ sesion_id: sesionId })
        });

        if (!iaResponse.ok) {
            const errorData = await iaResponse.json();
            throw new Error(errorData.detail || 'El servidor de IA no pudo procesar la solicitud.');
        }
        
        const diagnosticoIA = await iaResponse.json();
        llenarModalConIA(diagnosticoIA);

    } catch (iaError) {
        console.error("Error al obtener diagnóstico de IA:", iaError);
        if (diagnosticoGeneralElem) diagnosticoGeneralElem.innerHTML = `<i class="bi bi-exclamation-triangle-fill text-danger me-2"></i>Error: No se pudo obtener el diagnóstico de la IA. ${iaError.message}`;
    }
}

// ========================================================
// 5. Funciones auxiliares para el modal
// ========================================================
function llenarMetricasModal(datos) {
    document.getElementById('modBostIni').innerText = datos.INICIAL.num_bostezos;
    document.getElementById('modBostFin').innerText = datos.FINAL.num_bostezos;
    document.getElementById('modKssIni').innerText = datos.INICIAL.nivel_subjetivo;
    document.getElementById('modKssFin').innerText = datos.FINAL.nivel_subjetivo;
    document.getElementById('modVelIni').innerText = parseFloat(datos.INICIAL.velocidad_ocular).toFixed(1);
    document.getElementById('modVelFin').innerText = parseFloat(datos.FINAL.velocidad_ocular).toFixed(1);

    const estadoBadge = document.getElementById('modEstado');
    const esFatiga = datos.FINAL.estado_fatiga.toLowerCase().includes('fatiga');
    estadoBadge.innerText = esFatiga ? "FATIGA DETECTADA" : "ESTADO NORMAL";
    estadoBadge.className = `metric-badge ${esFatiga ? 'bg-danger' : 'bg-success'} text-white`;
}

function crearGraficosModal(datos) {
    const colorInicial = "#FFC300", colorFinal = "#4DA3FF";
    
    if (chartPerclos) chartPerclos.destroy();
    chartPerclos = new Chart(document.getElementById('modalChartPerclos').getContext('2d'), {
        type: 'bar', 
        data: { labels: ['Inicial', 'Final'], datasets: [{ data: [datos.INICIAL.perclos, datos.FINAL.perclos], backgroundColor: [colorInicial, colorFinal], borderRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    if (chartParpadeos) chartParpadeos.destroy();
    chartParpadeos = new Chart(document.getElementById('modalChartParpadeos').getContext('2d'), {
        type: 'line', 
        data: { labels: ['Inicial', 'Final'], datasets: [{ data: [datos.INICIAL.parpadeos, datos.FINAL.parpadeos], borderColor: colorFinal, fill: true, backgroundColor: "rgba(77,163,255,0.2)", tension: 0.3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

function llenarModalConIA(diagnosticoIA) {
    const diagnosticoGeneralElem = document.getElementById('iaDiagnosticoGeneral');
    const severidadContainer = document.getElementById('iaSeveridadContainer');
    const parametrosTbody = document.getElementById('iaParametrosTbody');
    const recomendacionesContainer = document.getElementById('iaRecomendacionesGenerales');

    if (diagnosticoGeneralElem) diagnosticoGeneralElem.textContent = diagnosticoIA.diagnostico_general;

    if(diagnosticoIA.severidad_fatiga_final && severidadContainer) {
        const severidad = diagnosticoIA.severidad_fatiga_final.toLowerCase();
        let badgeClass = 'bg-success'; // Leve
        if (severidad.includes('moderada')) badgeClass = 'bg-warning text-dark';
        else if (severidad.includes('alta') || severidad.includes('severa')) badgeClass = 'bg-danger';
        severidadContainer.innerHTML = `<p class="mb-0 mt-2"><strong>Severidad Final:</strong> <span class="badge ${badgeClass}">${diagnosticoIA.severidad_fatiga_final}</span></p>`;
    }

    if(parametrosTbody) {
        parametrosTbody.innerHTML = ''; // Limpiar antes de llenar
        for (const key in diagnosticoIA.evaluacion_parametros) {
            const param = diagnosticoIA.evaluacion_parametros[key];
            const row = `
                <tr>
                    <td class="text-capitalize fw-medium">${key.replace(/_/g, ' ')}</td>
                    <td><span class="badge text-bg-secondary">${param.valor_inicial}</span></td>
                    <td><span class="badge text-bg-primary">${param.valor_final}</span></td>
                    <td>${param.interpretacion}</td>
                </tr>
                <tr class="table-group-divider">
                    <td colspan="4" class="text-muted p-3" style="background-color: #f8f9fa;">
                        <i class="bi bi-lightbulb me-2"></i>${param.recomendacion}
                    </td>
                </tr>
            `;
            parametrosTbody.innerHTML += row;
        }
    }
    
    if(recomendacionesContainer) {
        let recomendacionesHtml = '<ul class="list-group list-group-flush">';
        diagnosticoIA.recomendaciones_generales.forEach(rec => {
            recomendacionesHtml += `<li class="list-group-item"><i class="bi bi-check-circle text-success me-2"></i>${rec}</li>`;
        });
        recomendacionesContainer.innerHTML = recomendacionesHtml + '</ul>';
    }
}