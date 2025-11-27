// ...existing code...
const videoElement = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const continueBtn = document.getElementById('continueBtn');

const blinkCountEl = document.getElementById('blinkCount');
const microCountEl = document.getElementById('microCount');

// elementos añadidos para gaze
const overlay = document.getElementById('overlay');
const overlayCtx = overlay ? overlay.getContext('2d') : null;
const gazeText = document.getElementById('gazeText');

// opcionales en HTML: sliders para ajustar preprocesado y un hint element
const brightnessRange = document.getElementById('brightnessRange'); // opcional
const contrastRange = document.getElementById('contrastRange'); // opcional
const saturationRange = document.getElementById('saturationRange'); // opcional
const lightHintEl = document.getElementById('lightHint'); // opcional (overlay texto)

let camera = null;
let running = false;

let conteo_parpadeos = 0;
let conteo_microsuenos = 0;
let parpadeo = false;
let inicio = 0;
let final = 0;

// buffer de aperturas (valor between 0..1) para suavizar con tfjs
const bufferSize = 15;
const aperturaBuffer = [];
const minBufferFill = 3;

// kernel para moving average (se usa con tfjs si está disponible)
let kernel = null;
if (typeof tf !== 'undefined') {
  kernel = tf.tensor1d(new Array(bufferSize).fill(1 / bufferSize), 'float32');
}

function actualizarUI() {
  if (blinkCountEl) blinkCountEl.textContent = conteo_parpadeos;
  if (microCountEl) microCountEl.textContent = conteo_microsuenos;
}

// calcula distancia entre dos landmarks (coord normalizadas) en pixeles relativos
function distanciaPx(p1, p2, w, h) {
  const dx = (p1.x - p2.x) * w;
  const dy = (p1.y - p2.y) * h;
  return Math.hypot(dx, dy);
}

const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.85, // más estricto para mayor precisión
  minTrackingConfidence: 0.85
});

// PREPROCESADO: canvas intermedio con filtros para mejorar iluminación
const preCanvas = document.createElement('canvas');
const preCtx = preCanvas.getContext('2d');
preCanvas.width = 640;
preCanvas.height = 480;

// asegurar overlay tamaño si existe
if (overlay) {
  overlay.width = preCanvas.width;
  overlay.height = preCanvas.height;
}

// parámetros por defecto (se pueden ajustar vía sliders si existen)
let pre_brightness = 110; // % (100 = sin cambio)
let pre_contrast = 120;   // %
let pre_saturation = 100; // %
let pre_gamma = 1.0;      // no usado por defecto

// si existen sliders en HTML, sincronizarlos
function initSliders() {
  if (brightnessRange) {
    brightnessRange.value = pre_brightness;
    brightnessRange.addEventListener('input', (e) => pre_brightness = Number(e.target.value));
  }
  if (contrastRange) {
    contrastRange.value = pre_contrast;
    contrastRange.addEventListener('input', (e) => pre_contrast = Number(e.target.value));
  }
  if (saturationRange) {
    saturationRange.value = pre_saturation;
    saturationRange.addEventListener('input', (e) => pre_saturation = Number(e.target.value));
  }
}
initSliders();

function showLightHint(on) {
  if (lightHintEl) {
    lightHintEl.style.display = on ? 'block' : 'none';
    return;
  }
  if (on) console.warn('Iluminación baja: coloca más luz frontal.');
}

// promedio de luminancia (muestreo)
function averageLuminanceFromCanvas(ctx, w, h, step = 12) {
  try {
    const img = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, count = 0;
    for (let i = 0; i < img.length; i += 4 * step) {
      sum += 0.2126 * img[i] + 0.7152 * img[i+1] + 0.0722 * img[i+2];
      count++;
    }
    return sum / Math.max(1, count);
  } catch (e) {
    return 255;
  }
}

// Mejoras para precisión de gaze
// - normalización por ancho del ojo (estable frente a zoom)
// - calibración automática (primeras frames) para quitar bias
// - suavizado EMA (más reactivo y estable)
const gazeEMAAlpha = 0.45; // mayor = más reactivo
let smoothGaze = { x: 0, y: 0 };
let gazeInitialized = false;

// calibración automática
const calibFrames = 60;
let calibCount = 0;
let calibSum = { x: 0, y: 0 };
let calibrated = false;
let baseline = { x: 0, y: 0 }; // bias a restar (en unidades normalizadas por eye width)
let eyeScale = 1.0; // factor basado en eye width

// indices robustos
const leftIrisIdx = [468, 469, 470, 471];
const rightIrisIdx = [473, 474, 475, 476];
const leftEyeCorners = [33, 133];   // outer, inner
const rightEyeCorners = [362, 263]; // outer, inner
const leftEyeContour = [33, 133, 159, 145];
const rightEyeContour = [362, 263, 386, 374];

// helper para promediar puntos
const avgPointFromLM = (lm, idxs) => {
  const sum = idxs.reduce((acc, i) => {
    const p = lm[i] || { x: 0, y: 0 };
    return { x: acc.x + p.x, y: acc.y + p.y };
  }, { x: 0, y: 0 });
  return { x: sum.x / idxs.length, y: sum.y / idxs.length };
};

const gazeBufferSize = 6; // buffer pequeño para fallback
const gazeBuffer = [];

// thresholds relativos (se usan sobre valor normalizado por eye width)
const BASE_TH_X = 0.08;
const BASE_TH_Y = 0.09;

faceMesh.onResults((results) => {
  if (!running) return;
  const w = preCanvas.width;
  const h = preCanvas.height;

  // limpiar overlay cada frame
  if (overlayCtx) {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const lm = results.multiFaceLandmarks[0];

    // PARPADEO (igual lógica pero manteniendo robustez)
    const L1 = lm[145], L2 = lm[159];
    const R1 = lm[374], R2 = lm[386];
    const ref = distanciaPx(lm[33], lm[263], w, h) || 1;
    const aperturaIzq = distanciaPx(L1, L2, w, h) / ref;
    const aperturaDer = distanciaPx(R1, R2, w, h) / ref;
    const aperturaProm = (aperturaIzq + aperturaDer) / 2;

    aperturaBuffer.push(aperturaProm);
    if (aperturaBuffer.length > bufferSize) aperturaBuffer.shift();

    let aperturaSuav = aperturaProm;
    if (kernel && aperturaBuffer.length >= minBufferFill) {
      tf.tidy(() => {
        const padded = (new Array(bufferSize - aperturaBuffer.length).fill(0)).concat(aperturaBuffer);
        const arr = tf.tensor1d(padded, 'float32');
        const reshaped = arr.reshape([1, bufferSize, 1]);
        const k = kernel.reshape([bufferSize, 1, 1]);
        const conv = tf.conv1d(reshaped, k, 1, 'valid');
        aperturaSuav = conv.reshape([1]).arraySync()[0];
      });
    } else if (!kernel && aperturaBuffer.length > 0) {
      aperturaSuav = aperturaBuffer.reduce((a, b) => a + b, 0) / aperturaBuffer.length;
    }

    const threshold = 0.03;
    if (aperturaSuav <= threshold && !parpadeo) {
      conteo_parpadeos += 1;
      parpadeo = true;
      inicio = performance.now() / 1000.0;
      actualizarUI();
    } else if (aperturaSuav > threshold && parpadeo) {
      parpadeo = false;
      final = performance.now() / 1000.0;
      const tiempo = Math.round((final - inicio) * 100) / 100;
      if (tiempo >= 3) {
        conteo_microsuenos += 1;
        actualizarUI();
      }
      inicio = 0;
      final = 0;
    }

    // GAZE TRACKING mejorado
    const leftIris = avgPointFromLM(lm, leftIrisIdx);
    const rightIris = avgPointFromLM(lm, rightIrisIdx);

    // centros del ojo (contornos)
    const leftEyeCenter = avgPointFromLM(lm, leftEyeContour);
    const rightEyeCenter = avgPointFromLM(lm, rightEyeContour);

    // ancho del ojo en pixeles (para normalizar)
    const leftEyeWidthPx = distanciaPx(lm[leftEyeCorners[0]], lm[leftEyeCorners[1]], w, h) || 1;
    const rightEyeWidthPx = distanciaPx(lm[rightEyeCorners[0]], lm[rightEyeCorners[1]], w, h) || 1;
    const eyeWidthPx = (leftEyeWidthPx + rightEyeWidthPx) / 2;

    // convertir diferencia iris-centro a pixeles y normalizar por eyeWidthPx -> unidad estable
    const dxLeftPx = (leftIris.x - leftEyeCenter.x) * w;
    const dyLeftPx = (leftIris.y - leftEyeCenter.y) * h;
    const dxRightPx = (rightIris.x - rightEyeCenter.x) * w;
    const dyRightPx = (rightIris.y - rightEyeCenter.y) * h;

    const dxPx = (dxLeftPx + dxRightPx) / 2;
    const dyPx = (dyLeftPx + dyRightPx) / 2;

    const ndx = dxPx / eyeWidthPx; // normalizado relativo al ancho del ojo
    const ndy = dyPx / eyeWidthPx; // usar eyeWidth para mantener escala similar en x/y

    // calibración automática durante primeros frames
    if (!calibrated) {
      calibSum.x += ndx;
      calibSum.y += ndy;
      calibCount++;
      // estimar escala basada en eyeWidth (si la cámara está muy cerca/alejada)
      eyeScale = Math.max(0.5, Math.min(2.5, eyeWidthPx / 40)); // heurística
      if (calibCount >= calibFrames) {
        baseline.x = calibSum.x / calibCount;
        baseline.y = calibSum.y / calibCount;
        calibrated = true;
        console.info('Calibración completada', baseline, 'eyeScale', eyeScale);
      } else if (calibCount % 15 === 0) {
        // feedback al usuario opcional
        if (gazeText) gazeText.textContent = `Calibrando... ${Math.round((calibCount / calibFrames) * 100)}%`;
      }
    }

    // aplicar baseline y escalar
    const adjX = ndx - (calibrated ? baseline.x : 0);
    const adjY = ndy - (calibrated ? baseline.y : 0);

    // suavizado EMA
    if (!gazeInitialized) {
      smoothGaze.x = adjX;
      smoothGaze.y = adjY;
      gazeInitialized = true;
    } else {
      smoothGaze.x = gazeEMAAlpha * adjX + (1 - gazeEMAAlpha) * smoothGaze.x;
      smoothGaze.y = gazeEMAAlpha * adjY + (1 - gazeEMAAlpha) * smoothGaze.y;
    }

    // Fallback buffer adicional (por si hay frames perdidos)
    gazeBuffer.push({ x: smoothGaze.x, y: smoothGaze.y });
    if (gazeBuffer.length > gazeBufferSize) gazeBuffer.shift();
    const avgGB = gazeBuffer.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y }), { x: 0, y: 0 });
    avgGB.x /= gazeBuffer.length;
    avgGB.y /= gazeBuffer.length;

    // umbrales adaptativos según eyeScale
    const TH_X = BASE_TH_X / eyeScale;
    const TH_Y = BASE_TH_Y / eyeScale;

    let horiz = 'centro';
    if (avgGB.x > TH_X) horiz = 'derecha';
    else if (avgGB.x < -TH_X) horiz = 'izquierda';

    let vert = '';
    if (avgGB.y > TH_Y) vert = ' abajo';
    else if (avgGB.y < -TH_Y) vert = ' arriba';

    if (gazeText) gazeText.textContent = calibrated ? `Mirada: ${horiz}${vert}` : `Calibrando...`;

    // dibujar indicadores en overlay (iris y vectores)
    if (overlayCtx) {
      const lx = leftIris.x * overlay.width;
      const ly = leftIris.y * overlay.height;
      const rx = rightIris.x * overlay.width;
      const ry = rightIris.y * overlay.height;
      const lcx = leftEyeCenter.x * overlay.width;
      const lcy = leftEyeCenter.y * overlay.height;
      const rcx = rightEyeCenter.x * overlay.width;
      const rcy = rightEyeCenter.y * overlay.height;

      overlayCtx.lineWidth = 2;
      // iris
      overlayCtx.strokeStyle = 'rgba(0,200,0,0.95)';
      overlayCtx.beginPath();
      overlayCtx.arc(lx, ly, 6, 0, Math.PI * 2);
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.arc(rx, ry, 6, 0, Math.PI * 2);
      overlayCtx.stroke();

      // lineas centro ojo -> iris
      overlayCtx.strokeStyle = 'rgba(255,165,0,0.95)';
      overlayCtx.beginPath();
      overlayCtx.moveTo(lcx, lcy);
      overlayCtx.lineTo(lx, ly);
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.moveTo(rcx, rcy);
      overlayCtx.lineTo(rx, ry);
      overlayCtx.stroke();

      // punto estimado de fijación: mapear avgGB a área del canvas (más controlado)
      // factor de visualización: multiplica el desplazamiento normalizado
      const visFactor = 4.5 * eyeScale;
      const fixX = overlay.width * (0.5 + avgGB.x * visFactor);
      const fixY = overlay.height * (0.5 + avgGB.y * visFactor);
      overlayCtx.fillStyle = 'rgba(0,120,255,0.95)';
      overlayCtx.beginPath();
      overlayCtx.arc(fixX, fixY, 8, 0, Math.PI * 2);
      overlayCtx.fill();

      // dibujar caja de ojo (para debugging)
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.25)';
      overlayCtx.beginPath();
      overlayCtx.rect((lcx - leftEyeWidthPx / 2), (lcy - leftEyeWidthPx / 4), leftEyeWidthPx, leftEyeWidthPx / 2);
      overlayCtx.stroke();
    }
  } else {
    // sin cara: limpiar overlay y texto
    if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    if (gazeText) gazeText.textContent = 'Mirada: no detectada';
  }
});

// Cámara usando Camera Utils de MediaPipe con preprocesado
function startCamera() {
  if (camera) return;
  camera = new Camera(videoElement, {
    onFrame: async () => {
      // dibujar video en canvas con filtros CSS
      preCtx.filter = `brightness(${pre_brightness}%) contrast(${pre_contrast}%) saturate(${pre_saturation}%)`;
      preCtx.drawImage(videoElement, 0, 0, preCanvas.width, preCanvas.height);

      // comprobar iluminación promedio y avisar si está muy baja
      const avg = averageLuminanceFromCanvas(preCtx, preCanvas.width, preCanvas.height, 12);
      showLightHint(avg < 40);

      // enviar canvas preprocesado a FaceMesh
      await faceMesh.send({ image: preCanvas });
    },
    width: preCanvas.width,
    height: preCanvas.height
  });
  awaitStartCamera();
}

async function awaitStartCamera() {
  try {
    await camera.start();
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    // establecer ruta absoluta coherente con el backend (templates)
    if (continueBtn) {
      continueBtn.style.display = 'inline-block';
      // si el href está vacío o relativo, forzar ruta a /actividades
      try {
        const currentHref = continueBtn.getAttribute('href') || '';
        if (!currentHref.startsWith('/')) {
          continueBtn.setAttribute('href', '/actividades');
        }
      } catch (e) {
        continueBtn.setAttribute('href', '/actividades');
      }
    }
  } catch (e) {
    console.error('Error al iniciar cámara:', e);
    alert('No se pudo iniciar la cámara: ' + (e.message || e));
  }
}

function stopCamera() {
  if (!camera) return;
  camera.stop();
  camera = null;
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
    startCamera();
  } catch (e) {
    alert('No se pudo acceder a la cámara: ' + (e.message || e));
  }
});

stopBtn.addEventListener('click', () => {
  stopCamera();
});

// actualizar ruta absoluta al pulsar (fallback si alguien modifica el href)
if (continueBtn) {
  continueBtn.addEventListener('click', (e) => {
    const href = continueBtn.getAttribute('href') || '';
    if (!href.startsWith('/')) {
      e.preventDefault();
      window.location.href = '/actividades';
    }
  });
}

// inicial UI
actualizarUI();
// ...existing code...