// ==========================================
// 1. CONFIGURACIÓN DINÁMICA (INICIAL VS FINAL)
// ==========================================

const urlParams = new URLSearchParams(window.location.search);
const tipoParam = urlParams.get('tipo'); 
const TIPO_ACTUAL = tipoParam === 'final' ? 'final' : 'inicial';

const pageTitle = document.getElementById('pageTitle');
const continueBtn = document.getElementById('continueBtn');

if (TIPO_ACTUAL === 'final') {
    if(pageTitle) pageTitle.textContent = "Reconocimiento Final de Fatiga";
    if(continueBtn) {
        continueBtn.href = "/templates/usuario/index.html";
        continueBtn.textContent = "Ver Informe Final";
    }
} else {
    if(pageTitle) pageTitle.textContent = "Reconocimiento Inicial de Fatiga";
    if(continueBtn) {
        continueBtn.href = "instruccion1.html";
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
const statusOverlay = document.getElementById('statusOverlay');

const blinkCountEl = document.getElementById('blinkCount');
const yawnCountEl = document.getElementById('yawnCount');
const timerEl = document.getElementById('timerCount');

let appState = 'IDLE';
let running = false;
let camera = null;
let startTime = 0;
let lastFrameTime = 0;

const CALIBRATION_DURATION = 10;
const MEASUREMENT_DURATION = 60;

let calibrationEARs = [];
let calibrationMARs = [];
let baselineEAR = 0;
let baselineMAR = 0;

let thresClose = 0.20; 
let thresOpen = 0.25;
let thresYawn = 0.50;

let blinkCounter = 0;
let incompleteBlinks = 0;
let accumulatedClosureTime = 0;
let measureFramesTotal = 0;
let measureFramesClosed = 0;

let isBlinking = false;
let minEarInBlink = 1.0;

let yawnCounter = 0;
let isYawning = false;
let yawnStartTime = 0;
const MIN_YAWN_TIME = 1.5;

let prevIrisPos = null;
let totalIrisDistance = 0;
let frameCount = 0;
const LEFT_IRIS_CENTER = 468;


// ==========================================
// 3. FUNCIONES MATEMÁTICAS
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
    const v1 = distanciaPx(lm[13], lm[14], w, h);
    const v2 = distanciaPx(lm[81], lm[178], w, h);
    const v3 = distanciaPx(lm[311], lm[402], w, h);
    const vertical = (v1 + v2 + v3) / 3.0;
    const horizontal = distanciaPx(lm[61], lm[291], w, h);
    return horizontal > 0 ? vertical / horizontal : 0;
}


// ==========================================
// 4. CONFIGURACIÓN MEDIAPIPE
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

        const currentEAR = calcularEAR(lm, w, h);
        const currentMAR = calcularMAR(lm, w, h);
        const currentIrisPos = { x: lm[LEFT_IRIS_CENTER].x, y: lm[LEFT_IRIS_CENTER].y };


        // ======================================
        //          ESTADOS DEL SISTEMA
        // ======================================

        if (appState === 'IDLE') {
            statusOverlay.textContent = "Listo para iniciar";

        } else if (appState === 'CALIBRATING') {
            const elapsed = now - startTime;
            statusOverlay.textContent = `CALIBRANDO (${Math.ceil(CALIBRATION_DURATION - elapsed)}s) `;

            calibrationEARs.push(currentEAR);
            calibrationMARs.push(currentMAR);

            if (elapsed >= CALIBRATION_DURATION) {

                baselineEAR = calibrationEARs.reduce((a,b)=>a+b,0) / calibrationEARs.length;
                baselineMAR = calibrationMARs.reduce((a,b)=>a+b,0) / calibrationMARs.length;

                thresClose = baselineEAR * 0.55;
                thresOpen  = baselineEAR * 0.85;
                thresYawn  = Math.max(0.5, baselineMAR + 0.30);

                appState = 'MEASURING';
                startTime = now;

                blinkCounter = 0;
                incompleteBlinks = 0;
                accumulatedClosureTime = 0;

                measureFramesClosed = 0;
                measureFramesTotal = 0;

                yawnCounter = 0;
                totalIrisDistance = 0;
                frameCount = 0;
            }


        } else if (appState === 'MEASURING') {

            const elapsed = now - startTime;
            const remaining = Math.ceil(MEASUREMENT_DURATION - elapsed);

            statusOverlay.textContent = `MIDIENDO... ${remaining}s`;
            timerEl.textContent = `${remaining}s`;

            measureFramesTotal++;

            // -------------------------
            // DETECCIÓN DE PARPADEO
            // -------------------------
            if (currentEAR < thresClose) {
                if (!isBlinking) {
                    isBlinking = true;
                    minEarInBlink = currentEAR;
                } else {
                    if (currentEAR < minEarInBlink) minEarInBlink = currentEAR;
                }

                measureFramesClosed++;
                accumulatedClosureTime += deltaTime;

            } else if (currentEAR > thresOpen && isBlinking) {

                blinkCounter++;
                blinkCountEl.textContent = blinkCounter;

                if (minEarInBlink > (thresClose * 0.7)) {
                    incompleteBlinks++;
                }

                isBlinking = false;
            }

            // -------------------------
            // DETECCIÓN DE BOSTEZO
            // -------------------------
            if (currentMAR > thresYawn) {
                if (!isYawning) {
                    isYawning = true;
                    yawnStartTime = now;
                }

            } else {
                if (isYawning) {
                    const dur = now - yawnStartTime;
                    if (dur > MIN_YAWN_TIME) {
                        yawnCounter++;
                        yawnCountEl.textContent = yawnCounter;
                    }
                }
                isYawning = false;
            }

            // -------------------------
            // VELOCIDAD SACÁDICA
            // -------------------------
            if (prevIrisPos) {
                const dist = Math.hypot(
                    currentIrisPos.x - prevIrisPos.x,
                    currentIrisPos.y - prevIrisPos.y
                );
                totalIrisDistance += dist;
                frameCount++;
            }
            prevIrisPos = currentIrisPos;

            // -------------------------
            // FIN DE LA MEDICIÓN
            // -------------------------
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
// 5. CONTROL DE CÁMARA
// ==========================================

function startCamera() {
    if (!camera) {
        camera = new Camera(videoElement, {
            onFrame: async () => {
                await faceMesh.send({ image: videoElement });
            },
            width: 640,
            height: 480
        });
    }

    camera.start().then(() => {
        running = true;
        startBtn.disabled = true;
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
    statusOverlay.textContent = "Prueba Finalizada";
}

if (startBtn) startBtn.addEventListener('click', startCamera);


// ==========================================
// 6. GUARDADO Y ENVÍO DE MÉTRICAS
// ==========================================

const loaderContainer = document.getElementById('loader-container');

function mostrarModalSubjetivo() {
    document.getElementById('subjectiveModal').style.display = 'flex';
}


window.guardarYContinuar = async function() {

    const kssSelect = document.getElementById('kssSelect');
    const kssValue = kssSelect ? kssSelect.value : "1";

    // ======================================
    //     CÁLCULO DE MÉTRICAS CRÍTICAS
    // ======================================
    
    const SEBR = blinkCounter;
    const PERCLOS = measureFramesTotal > 0 
        ? (measureFramesClosed / measureFramesTotal) * 100 
        : 0;

    const PctIncompletos = blinkCounter > 0 
        ? (incompleteBlinks / blinkCounter) * 100 
        : 0;

    const avgVelocity = frameCount > 5 
        ? parseFloat(((totalIrisDistance / frameCount) * 100).toFixed(4))
        : 0;

    // ======================================
    //     DETECCIÓN DE FATIGA REFINADA
    // ======================================

    let nivelFatiga = 0;

    // → MÉTRICAS PRIMARIAS
    if (PERCLOS >= 28) nivelFatiga += 3;
    if (SEBR <= 5) nivelFatiga += 3;
    if (PctIncompletos >= 20) nivelFatiga += 2;

    // → MÉTRICAS SECUNDARIAS
    if (yawnCounter >= 1) nivelFatiga += 1;
    if (avgVelocity < 0.02) nivelFatiga += 1;
    if (accumulatedClosureTime >= 3) nivelFatiga += 1;

    // → SUBJETIVA (KSS)
    if (parseInt(kssValue) >= 7) nivelFatiga += 1;

    const es_fatiga = nivelFatiga >= 3;


    // ======================================
    //      PREPARAR Y ENVIAR PAYLOAD
    // ======================================

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
        velocidad_ocular: avgVelocity,
        nivel_subjetivo: parseInt(kssValue),
        es_fatiga: es_fatiga
    };

    console.log("Payload de medición final:", payload);

    document.getElementById('subjectiveModal').style.display = 'none';
    if (loaderContainer) loaderContainer.style.display = 'flex';

    try {
        const response = await fetch("http://localhost:8000/save-fatigue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (loaderContainer) loaderContainer.style.display = 'none';

        const result = await response.json();

        if (response.ok) {
            const resultTextEl = document.getElementById('resultText');
            const resultReasonsEl = document.getElementById('resultReasons');

            resultTextEl.textContent = es_fatiga
                ? "Diagnóstico: FATIGA DETECTADA"
                : "Diagnóstico: ESTADO NORMAL";

            resultTextEl.style.color = es_fatiga ? "#e74c3c" : "#27ae60";

            if (result.diagnostico_detallado_ia && result.diagnostico_detallado_ia.detailed_recommendation) {
                resultReasonsEl.innerHTML =
                    `<strong>Recomendación IA:</strong> ${result.diagnostico_detallado_ia.detailed_recommendation}`;
            } else {
                resultReasonsEl.textContent =
                    "El análisis detallado por IA se mostrará en tu panel principal.";
            }

            document.getElementById('resultModal').style.display = 'flex';

        } else {
            alert("Error al guardar: " + (result.detail || "Error desconocido"));
        }

    } catch (e) {
        console.error("Error al enviar medición:", e);
        alert("No se pudo conectar al servidor (localhost:8000). Verifica el backend.");
    }
};
