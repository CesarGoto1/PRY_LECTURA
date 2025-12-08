// ========================================================
// FUNCIÓN GLOBAL PARA CERRAR SESIÓN (admin y usuario)
// ========================================================
function cerrarSesion() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "/templates/login.html";
}

// ========================================================
// FUNCIÓN GLOBAL PARA PROTEGER RUTAS
// protegerRuta("admin")  → solo admin
// protegerRuta("usuario") → solo estudiante
// ========================================================
function protegerRuta(rolRequerido) {
    const usuarioStr = localStorage.getItem("usuario");

    if (!usuarioStr) {
        window.location.href = "/templates/login.html";
        return;
    }

    const usuario = JSON.parse(usuarioStr);

    if (rolRequerido === "admin" && usuario.rol !== "admin") {
        alert("Acceso denegado.");
        window.location.href = "/templates/usuario/index.html";
        return;
    }

    if (rolRequerido === "usuario" && usuario.rol !== "usuario") {
        alert("Acceso denegado.");
        window.location.href = "/templates/admin/index.html";
        return;
    }
}

// ========================================================
// OBTENER USUARIO GENERAL (si se necesita en tablas o UI)
// ========================================================
function obtenerUsuarioSimple() {
    const usuarioStr = localStorage.getItem("usuario");
    return usuarioStr ? JSON.parse(usuarioStr) : null;
}
