// En este archivo, reemplaza la URL por la que te proporcionó Railway para tu backend.
const API_BASE_URL = "https://web-production-9255.up.railway.app/";

async function register(){
  const nombre = document.getElementById('nombre').value.trim();
  const apellido = document.getElementById('apellido').value.trim();
  const correo = document.getElementById('correo').value.trim();
  const contrasena = document.getElementById('contrasena').value.trim();
  const msg = document.getElementById('msg');
  msg.textContent = ""; 
  msg.className = "";

  // VALIDACIÓN BÁSICA
  if(!nombre || !apellido || !correo || !contrasena){
    msg.textContent = "Todos los campos son obligatorios.";
    msg.className = "error";
    return;
  }

  // Validación simple de correo
  if(!correo.includes("@") || !correo.includes(".")){
    msg.textContent = "Ingrese un correo válido.";
    msg.className = "error";
    return;
  }

  // Validación mínima de contraseña
  if(contrasena.length < 4){
    msg.textContent = "La contraseña debe tener al menos 4 caracteres.";
    msg.className = "error";
    return;
  }

  try{
    const resp = await fetch(`${API_BASE_URL}register`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ nombre, apellido, correo, contrasena })
    });

    const data = await resp.json();

    if(!resp.ok){
      msg.textContent = data.detail || "Error en el registro";
      msg.className = "error";
      return;
    }

    // Registro exitoso
    msg.textContent = "Cuenta creada con éxito";
    msg.className = "success";

    setTimeout(() => {
      location.href = "login.html";
    }, 900);

  }catch(e){
    msg.textContent = "Error de conexión con el servidor";
    msg.className = "error";
    console.error(e);
  }
}