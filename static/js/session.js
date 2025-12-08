
function cerrarSesion(){
    localStorage.removeItem("usuario");
    window.location.href = "/templates/login.html";
}

function protegerRuta(rolRequerido){
    const usuario = JSON.parse(localStorage.getItem("usuario"));

    if(!usuario){
        window.location.href = "/templates/login.html";
        return;
    }

    if(rolRequerido === "admin" && usuario.rol !== "admin"){
        window.location.href = "/templates/admin/index.html";
        return;
    }

    if(rolRequerido === "usuario" && usuario.rol !== "usuario"){
        window.location.href = "/templates/usuario/index.html";
        return;
    }
}
