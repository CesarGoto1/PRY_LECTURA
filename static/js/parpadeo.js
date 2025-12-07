// ==========================================
// CONFIGURACIÓN Y REFERENCIAS DOM
// ==========================================
const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const continueBtn = document.getElementById('continueBtn');
const statusOverlay = document.getElementById('statusOverlay');

// Stats Elements
const blinkCountEl = document.getElementById('blinkCount');
const yawnCountEl = document.getElementById('yawnCount');
const timerEl = document.getElementById('timerCount');

// ==========================================
// VARIABLES GLOBALES DEL SISTEMA
// ==========================================
let appState = 'IDLE'; 
let running = false;
let camera = null;
let startTime = 0;
let lastFrameTime = 0;

// Constantes de Tiempo
const CALIBRATION_DURATION = 10;
const MEASUREMENT_DURATION = 60;

// Variables de Calibración
let calibrationEARs = []; 
let calibrationMARs = []; 
let baselineEAR = 0; 
let baselineMAR = 0;

// Umbrales Dinámicos
let thresClose = 0; 
let thresOpen = 0;
let thresYawn = 0.5;

// Variables de Medición
let blinkCounter = 0;         
let incompleteBlinks = 0;     
let accumulatedClosureTime = 0; 
let measureFramesTotal = 0;
let measureFramesClosed = 0;

// Variables Lógicas (Parpadeo)
let isBlinking = false;
let minEarInBlink = 1.0; 

// Variables Bostezos
let yawnCounter = 0;
let isYawning = false;
let yawnStartTime = 0;
const MIN_YAWN_TIME = 1.5; 

// Variables Velocidad Ocular
let prevIrisPos = null;
let totalIrisDistance = 0;
let frameCount = 0;
const LEFT_IRIS_CENTER = 468;

// ==========================================
// FUNCIONES AUXILIARES MATEMÁTICAS
// ==========================================

function distanciaPx(p1, p2, w, h) {
    const dx = (p1.x - p2.x) * w;
    const dy = (p1.y - p2.y) * h;
    return Math.hypot(dx, dy);
}

function calcularEAR(lm, w, h) {
    const l_v1 = distanciaPx(lm[160], lm[144], w, h);
    const l_v2 = distanciaPx(lm[158], lm[153], w, h);
    const l_h  = distanciaPx(lm[33],  lm[133], w, h);
    const ear_l = (l_v1 + l_v2) / (2.0 * l_h);

    const r_v1 = distanciaPx(lm[385], lm[380], w, h);
    const r_v2 = distanciaPx(lm[387], lm[373], w, h);
    const r_h  = distanciaPx(lm[362], lm[263], w, h);
    const ear_r = (r_v1 + r_v2) / (2.0 * r_h);

    return (ear_l + ear_r) / 2.0;
}

function calcularMAR(lm, w, h) {
    // 1. Línea Vertical Central
    const v1 = distanciaPx(lm[13], lm[14], w, h);
    // 2. Líneas Verticales Laterales
    const v2 = distanciaPx(lm[81], lm[178], w, h);
    const v3 = distanciaPx(lm[311], lm[402], w, h);
    
    const vertical = (v1 + v2 + v3) / 3.0;
    const horizontal = distanciaPx(lm[61], lm[291], w, h);

    return horizontal > 0 ? vertical / horizontal : 0;
}

// ==========================================
// LÓGICA PRINCIPAL (MediaPipe)
// ==========================================

const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
});

faceMesh.onResults((results) => {
    if (!running) return;

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

        drawConnectors(canvasCtx, lm, FACEMESH_TESSELATION, {color: '#C0C0C030', lineWidth: 1});

        const currentEAR = calcularEAR(lm, w, h);
        const currentMAR = calcularMAR(lm, w, h);
        const currentIrisPos = { x: lm[LEFT_IRIS_CENTER].x, y: lm[LEFT_IRIS_CENTER].y };

        if (appState === 'IDLE') {
            statusOverlay.textContent = "Listo. Presiona 'Iniciar Test'";
            statusOverlay.style.color = "white";
        
        } else if (appState === 'CALIBRATING') {
            const elapsed = now - startTime;
            statusOverlay.textContent = `CALIBRANDO (${Math.ceil(CALIBRATION_DURATION - elapsed)}s) - Mira naturalmente`;
            statusOverlay.style.color = "yellow";
            
            calibrationEARs.push(currentEAR);
            calibrationMARs.push(currentMAR); 

            if (elapsed >= CALIBRATION_DURATION) {
                // Calibrar Ojos
                const sumEar = calibrationEARs.reduce((a, b) => a + b, 0);
                baselineEAR = sumEar / calibrationEARs.length;
                
                thresClose = baselineEAR * 0.50; 
                thresOpen = baselineEAR * 0.80; 

                // Calibrar Boca
                const sumMar = calibrationMARs.reduce((a, b) => a + b, 0);
                baselineMAR = sumMar / calibrationMARs.length;
                
                // Umbral dinámico para bostezo
                thresYawn = Math.max(0.5, baselineMAR + 0.35);

                console.log(`Calibración Completa. EAR: ${baselineEAR.toFixed(3)}, MAR: ${baselineMAR.toFixed(3)}, ThresYawn: ${thresYawn.toFixed(3)}`);
                
                appState = 'MEASURING';
                startTime = now;
                
                // Reset contadores
                blinkCounter = 0; incompleteBlinks = 0; yawnCounter = 0;
                accumulatedClosureTime = 0; measureFramesTotal = 0; measureFramesClosed = 0;
                totalIrisDistance = 0; frameCount = 0;
            }

        } else if (appState === 'MEASURING') {
            const elapsed = now - startTime;
            const remaining = Math.ceil(MEASUREMENT_DURATION - elapsed);
            statusOverlay.textContent = `MIDIENDO... ${remaining}s`;
            timerEl.textContent = `${remaining}s`;

            measureFramesTotal++;

            // --- A. DETECCIÓN PARPADEO ---
            if (currentEAR < thresClose) {
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
                blinkCounter++;
                blinkCountEl.textContent = blinkCounter;
                if (minEarInBlink > (thresClose * 0.8)) {
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

            // --- C. VELOCIDAD OCULAR ---
            if (prevIrisPos) {
                const dist = Math.hypot(currentIrisPos.x - prevIrisPos.x, currentIrisPos.y - prevIrisPos.y);
                totalIrisDistance += dist;
                frameCount++;
            }
            prevIrisPos = currentIrisPos;

            // Finalizar
            if (elapsed >= MEASUREMENT_DURATION) {
                appState = 'FINISHED';
                stopCamera();
                mostrarModalSubjetivo();
            }
        }
    }
    canvasCtx.restore();
});

// ==========================================
// GESTIÓN DE CÁMARA
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
        calibrationEARs = [];
        calibrationMARs = [];
    });
}

function stopCamera() {
    running = false;
    if (camera) camera.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusOverlay.textContent = "Test Finalizado";
    statusOverlay.style.color = "white";
}

if(startBtn) startBtn.addEventListener('click', startCamera);
if(stopBtn) stopBtn.addEventListener('click', stopCamera);

// ==========================================
// ENVÍO DE RESULTADOS Y MODALES
// ==========================================

function mostrarModalSubjetivo() {
    const modal = document.getElementById('subjectiveModal');
    if(modal) modal.style.display = 'flex';
}

window.guardarYContinuar = async function() {
    const kssSelect = document.getElementById('kssSelect');
    const kssValue = kssSelect ? kssSelect.value : "1";
    
    const SEBR = blinkCounter;
    const PERCLOS = measureFramesTotal > 0 ? (measureFramesClosed / measureFramesTotal) * 100 : 0;
    const PctIncompletos = blinkCounter > 0 ? (incompleteBlinks / blinkCounter) * 100 : 0;
    const avgVelocity = frameCount > 0 ? (totalIrisDistance / frameCount) * 100 : 0;

    let esFatiga = false;
    let razones = [];

    if (SEBR <= 5) { esFatiga = true; razones.push("SEBR bajo"); }
    if (PERCLOS >= 6) { esFatiga = true; razones.push("PERCLOS alto"); }
    if (PctIncompletos >= 15) { esFatiga = true; razones.push("Muchos parpadeos incompletos"); }
    if (accumulatedClosureTime >= 3.5) { esFatiga = true; razones.push("Cierre ocular prolongado"); }
    if (yawnCounter >= 2) { esFatiga = true; razones.push("Bostezos frecuentes"); }
    if (parseInt(kssValue) >= 7) razones.push("Fatiga subjetiva reportada");

    const storedUser = JSON.parse(sessionStorage.getItem('usuario')) || { id: 1 };
    
    // DETECCIÓN INTELIGENTE DEL TIPO DE PRUEBA
    // Si definiste <script>const TIPO_PRUEBA="final"</script> en el HTML, usará eso.
    // Si no, mirará si la URL tiene la palabra "final".
    let tipoDeterminado = "inicial";
    if (typeof TIPO_PRUEBA !== 'undefined') {
        tipoDeterminado = TIPO_PRUEBA;
    } else if (window.location.href.toLowerCase().includes("final")) {
        tipoDeterminado = "final";
    }

    const payload = {
        usuario_id: storedUser.id,
        tipo_medicion: tipoDeterminado,
        sebr: SEBR,
        perclos: parseFloat(PERCLOS.toFixed(2)),
        pct_incompletos: parseFloat(PctIncompletos.toFixed(2)),
        tiempo_cierre: parseFloat(accumulatedClosureTime.toFixed(2)),
        num_bostezos: yawnCounter,
        velocidad_ocular: parseFloat(avgVelocity.toFixed(2)),
        nivel_subjetivo: parseInt(kssValue),
        es_fatiga: esFatiga
    };

    try {
        const response = await fetch('http://localhost:8000/save-fatigue', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            document.getElementById('subjectiveModal').style.display = 'none';
            
            const diagnosisText = `Diagnóstico: ${esFatiga ? "FATIGA" : "NORMAL"}`;
            const reasonsText = razones.length > 0 ? razones.join(", ") : "Sin indicadores adicionales";
            
            const resultTextEl = document.getElementById('resultText');
            const resultReasonsEl = document.getElementById('resultReasons');
            const resultModal = document.getElementById('resultModal');

            if (resultTextEl) resultTextEl.textContent = diagnosisText;
            if (resultReasonsEl) resultReasonsEl.textContent = reasonsText;
            if (resultModal) resultModal.style.display = 'flex';

            if (continueBtn) continueBtn.style.display = 'inline-block';
        } else {
            alert("Error al guardar datos. Revisa la consola.");
        }
    } catch (e) {
        console.error(e);
        alert("Error de conexión con el servidor.");
    }
}

window.closeResultModal = function() {
    const modal = document.getElementById('resultModal');
    if (modal) modal.style.display = 'none';
};