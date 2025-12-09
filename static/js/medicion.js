// ==========================================
// 1. CONFIGURACIÓN DINÁMICA (INICIAL VS FINAL)
// ==========================================

// Detectar parámetro en la URL (ej: medicion_fatiga.html?tipo=final)
const urlParams = new URLSearchParams(window.location.search);
const tipoParam = urlParams.get('tipo'); 
const TIPO_ACTUAL = tipoParam === 'final' ? 'final' : 'inicial';

// Referencias DOM para UI dinámica
const pageTitle = document.getElementById('pageTitle');
const continueBtn = document.getElementById('continueBtn');

// Aplicar configuración inicial
if (TIPO_ACTUAL === 'final') {
    if(pageTitle) pageTitle.textContent = "Reconocimiento Final de Fatiga";
    if(continueBtn) {
        continueBtn.href = "/templates/usuario/index.html"; // Ruta a resultados finales
        continueBtn.textContent = "Ver Informe Final";
    }
} else {
    if(pageTitle) pageTitle.textContent = "Reconocimiento Inicial de Fatiga";
    if(continueBtn) {
        continueBtn.href = "instruccion1.html"; // Ruta a la primera actividad
        continueBtn.textContent = "Ir a Actividad 1";
    }
}

console.log(`Sistema configurado en modo: ${TIPO_ACTUAL.toUpperCase()}`);

// ==========================================
// 2. VARIABLES GLOBALES Y REFERENCIAS
// ==========================================
const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusOverlay = document.getElementById('statusOverlay');

// Elementos de Estadísticas
const blinkCountEl = document.getElementById('blinkCount');
const yawnCountEl = document.getElementById('yawnCount');
const timerEl = document.getElementById('timerCount');

// Estado del Sistema
let appState = 'IDLE'; // IDLE, CALIBRATING, MEASURING, FINISHED
let running = false;
let camera = null;
let startTime = 0;
let lastFrameTime = 0;

// Configuración de Tiempos
const CALIBRATION_DURATION = 10; // Segundos de calibración
const MEASUREMENT_DURATION = 60; // Segundos de medición real

// Variables de Calibración
let calibrationEARs = []; 
let calibrationMARs = []; 
let baselineEAR = 0; 
let baselineMAR = 0;

// Umbrales Dinámicos (se calculan tras calibrar)
let thresClose = 0.20; 
let thresOpen = 0.25;
let thresYawn = 0.50;

// Variables de Medición
let blinkCounter = 0;         
let incompleteBlinks = 0;     
let accumulatedClosureTime = 0; 
let measureFramesTotal = 0;
let measureFramesClosed = 0;

// Lógica de Parpadeo
let isBlinking = false;
let minEarInBlink = 1.0; 

// Lógica de Bostezos
let yawnCounter = 0;
let isYawning = false;
let yawnStartTime = 0;
const MIN_YAWN_TIME = 1.5; // Segundos para considerar bostezo real

// Lógica de Velocidad Ocular (Movimiento del Iris)
let prevIrisPos = null;
let totalIrisDistance = 0;
let frameCount = 0;
const LEFT_IRIS_CENTER = 468; // Landmark de MediaPipe

// ==========================================
// 3. FUNCIONES MATEMÁTICAS (EAR, MAR, DISTANCIA)
// ==========================================

function distanciaPx(p1, p2, w, h) {
    const dx = (p1.x - p2.x) * w;
    const dy = (p1.y - p2.y) * h;
    return Math.hypot(dx, dy);
}

// Eye Aspect Ratio
function calcularEAR(lm, w, h) {
    // Ojo Izquierdo
    const l_v1 = distanciaPx(lm[160], lm[144], w, h);
    const l_v2 = distanciaPx(lm[158], lm[153], w, h);
    const l_h  = distanciaPx(lm[33],  lm[133], w, h);
    const ear_l = (l_v1 + l_v2) / (2.0 * l_h);

    // Ojo Derecho
    const r_v1 = distanciaPx(lm[385], lm[380], w, h);
    const r_v2 = distanciaPx(lm[387], lm[373], w, h);
    const r_h  = distanciaPx(lm[362], lm[263], w, h);
    const ear_r = (r_v1 + r_v2) / (2.0 * r_h);

    return (ear_l + ear_r) / 2.0;
}

// Mouth Aspect Ratio (para bostezos)
function calcularMAR(lm, w, h) {
    const v1 = distanciaPx(lm[13], lm[14], w, h);
    const v2 = distanciaPx(lm[81], lm[178], w, h);
    const v3 = distanciaPx(lm[311], lm[402], w, h);
    const vertical = (v1 + v2 + v3) / 3.0;
    const horizontal = distanciaPx(lm[61], lm[291], w, h);
    return horizontal > 0 ? vertical / horizontal : 0;
}

// ==========================================
// 4. CONFIGURACIÓN MEDIAPIPE FACE MESH
// ==========================================

const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true, // Importante para iris y detalles de ojos
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
});

faceMesh.onResults((results) => {
    if (!running) return;

    // Dibujar video en canvas
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    const now = performance.now() / 1000;
    const deltaTime = now - lastFrameTime;
    lastFrameTime = now;

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const lm = results.multiFaceLandmarks[0];
        const w = canvasElement.width;
        const h = canvasElement.height;

        // Dibujo opcional (puedes descomentar para ver la malla)
        // drawConnectors(canvasCtx, lm, FACEMESH_TESSELATION, {color: '#C0C0C030', lineWidth: 1});

        // Cálculos Métricos del Frame Actual
        const currentEAR = calcularEAR(lm, w, h);
        const currentMAR = calcularMAR(lm, w, h);
        const currentIrisPos = { x: lm[LEFT_IRIS_CENTER].x, y: lm[LEFT_IRIS_CENTER].y };

        // --- MÁQUINA DE ESTADOS ---
        
        if (appState === 'IDLE') {
            statusOverlay.textContent = "Listo para iniciar";
            statusOverlay.style.color = "white";
        
        } else if (appState === 'CALIBRATING') {
            const elapsed = now - startTime;
            statusOverlay.textContent = `CALIBRANDO (${Math.ceil(CALIBRATION_DURATION - elapsed)}s) - Mira al frente naturalmente`;
            statusOverlay.style.color = "yellow";
            
            // Recolectar datos para promedio
            calibrationEARs.push(currentEAR);
            calibrationMARs.push(currentMAR); 

            if (elapsed >= CALIBRATION_DURATION) {
                // FIN CALIBRACIÓN: Calcular Promedios
                const sumEar = calibrationEARs.reduce((a, b) => a + b, 0);
                baselineEAR = sumEar / calibrationEARs.length;
                
                // Definir umbrales personalizados según la anatomía del usuario
                thresClose = baselineEAR * 0.55; // Cerrado es el 55% del ojo abierto promedio
                thresOpen = baselineEAR * 0.85;  // Abierto debe recuperar el 85%
                
                const sumMar = calibrationMARs.reduce((a, b) => a + b, 0);
                baselineMAR = sumMar / calibrationMARs.length;
                thresYawn = Math.max(0.5, baselineMAR + 0.30); // Bostezo es apertura grande

                console.log(`Calibrado: EAR Base=${baselineEAR.toFixed(3)}, Close<${thresClose.toFixed(3)}, Yawn>${thresYawn.toFixed(3)}`);
                
                // Cambiar estado a Midiendo
                appState = 'MEASURING';
                startTime = now; // Reiniciar tiempo para medición
                
                // Resetear contadores
                blinkCounter = 0; incompleteBlinks = 0; yawnCounter = 0;
                accumulatedClosureTime = 0; measureFramesTotal = 0; measureFramesClosed = 0;
                totalIrisDistance = 0; frameCount = 0;
            }

        } else if (appState === 'MEASURING') {
            const elapsed = now - startTime;
            const remaining = Math.ceil(MEASUREMENT_DURATION - elapsed);
            
            statusOverlay.textContent = `MIDIENDO... ${remaining}s`;
            statusOverlay.style.color = "#00ff00"; // Verde
            timerEl.textContent = `${remaining}s`;

            measureFramesTotal++;

            // --- A. DETECCIÓN DE PARPADEO ---
            if (currentEAR < thresClose) {
                // Ojo cerrado
                if (!isBlinking) {
                    isBlinking = true;
                    minEarInBlink = currentEAR;
                } else {
                    if (currentEAR < minEarInBlink) minEarInBlink = currentEAR;
                }
                measureFramesClosed++;
                accumulatedClosureTime += deltaTime;
            } 
            else if (currentEAR > thresOpen && isBlinking) {
                // Fin del parpadeo (Ojo abierto de nuevo)
                blinkCounter++;
                blinkCountEl.textContent = blinkCounter;
                
                // Verificar si fue incompleto (no cerró suficiente)
                if (minEarInBlink > (thresClose * 0.7)) { 
                    incompleteBlinks++;
                }
                isBlinking = false;
            }

            // --- B. DETECCIÓN DE BOSTEZOS ---
            if (currentMAR > thresYawn) {
                if (!isYawning) {
                    isYawning = true;
                    yawnStartTime = now;
                }
            } else {
                if (isYawning) {
                    const yawnDuration = now - yawnStartTime;
                    if (yawnDuration > MIN_YAWN_TIME) {
                        yawnCounter++;
                        yawnCountEl.textContent = yawnCounter;
                    }
                    isYawning = false;
                }
            }

            // --- C. VELOCIDAD OCULAR (Sacádicos / Fatiga) ---
            if (prevIrisPos) {
                const dist = Math.hypot(currentIrisPos.x - prevIrisPos.x, currentIrisPos.y - prevIrisPos.y);
                totalIrisDistance += dist;
                frameCount++;
            }
            prevIrisPos = currentIrisPos;

            // --- FIN DE LA MEDICIÓN ---
            if (elapsed >= MEASUREMENT_DURATION) {
                appState = 'FINISHED';
                stopCamera();
                mostrarModalSubjetivo(); // Lanzar popup
            }
        }
    }
    canvasCtx.restore();
});

// ==========================================
// 5. CONTROL DE CÁMARA Y BOTONES
// ==========================================

function startCamera() {
    if (!camera) {
        camera = new Camera(videoElement, {
            onFrame: async () => {
                await faceMesh.send({image: videoElement});
            },
            width: 640,
            height: 480
        });
    }
    camera.start().then(() => {
        running = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        appState = 'CALIBRATING';
        startTime = performance.now() / 1000;
        
        // Limpiar arrays de calibración
        calibrationEARs = [];
        calibrationMARs = [];
    });
}

function stopCamera() {
    running = false;
    if (camera) camera.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusOverlay.textContent = "Prueba Finalizada";
    statusOverlay.style.color = "white";
}

// Listeners
if(startBtn) startBtn.addEventListener('click', startCamera);
if(stopBtn) stopBtn.addEventListener('click', stopCamera);

// ==========================================
// 6. GUARDADO DE DATOS Y MODALES (MODIFICADO)
// ==========================================

function mostrarModalSubjetivo() {
    document.getElementById('subjectiveModal').style.display = 'flex';
}

window.guardarYContinuar = async function() {
    const kssSelect = document.getElementById('kssSelect');
    const kssValue = kssSelect ? kssSelect.value : "1";
    
    // --- CÁLCULO DE MÉTRICAS DE FATIGA ---
    const SEBR = blinkCounter;
    const PERCLOS = measureFramesTotal > 0 
        ? (measureFramesClosed / measureFramesTotal) * 100 
        : 0;
    const PctIncompletos = blinkCounter > 0 
        ? (incompleteBlinks / blinkCounter) * 100 
        : 0;
    const avgVelocity = frameCount > 0 
        ? (totalIrisDistance / frameCount) * 100 
        : 0;

    // --- ALGORITMO SIMPLE DE DIAGNÓSTICO ---
    let esFatiga = false;
    if (SEBR <= 8) esFatiga = true;
    if (PERCLOS >= 8) esFatiga = true;
    if (PctIncompletos >= 40) esFatiga = true;
    if (yawnCounter >= 2) esFatiga = true;

    // --- PREPARAR PAYLOAD ---
    const storedUser = JSON.parse(localStorage.getItem('usuario'));
    if (!storedUser) {
        alert("Debes iniciar sesión antes de realizar la medición.");
        window.location.href = "/templates/login.html";
        return;
    }

    const payload = {
        usuario_id: storedUser.id,
        tipo_medicion: TIPO_ACTUAL,
        sebr: SEBR,
        perclos: parseFloat(PERCLOS.toFixed(2)),
        pct_incompletos: parseFloat(PctIncompletos.toFixed(2)),
        tiempo_cierre: parseFloat(accumulatedClosureTime.toFixed(2)),
        num_bostezos: yawnCounter,
        velocidad_ocular: parseFloat(avgVelocity.toFixed(2)),
        nivel_subjetivo: parseInt(kssValue),
        es_fatiga: esFatiga
    };

    console.log("Enviando datos:", payload);
    document.getElementById('subjectiveModal').style.display = 'none';

    try {
        const response = await fetch('http://localhost:8000/save-fatigue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log("Respuesta del servidor recibida con éxito.");
            
            if (TIPO_ACTUAL === 'final') {
                // Medición FINAL -> Mostrar alerta y redirigir al panel
                alert("¡Análisis final completado! Serás redirigido al panel de usuario para ver el informe completo.");
                window.location.href = '/templates/usuario/index.html';
            } else {
                // Medición INICIAL -> Redirigir a la primera actividad
                window.location.href = 'instruccion1.html';
            }
        } else {
            const err = await response.json();
            console.error("Error del servidor:", err);
            alert("Error al guardar en el servidor: " + (err.detail || "Error desconocido"));
        }
    } catch (e) {
        console.error("Error de conexión:", e);
        alert("No se pudo conectar con el servidor (localhost:8000).");
    }
}