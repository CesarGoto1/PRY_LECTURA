// ========================================================
// FUNCIÓN GLOBAL PARA CERRAR SESIÓN (admin y usuario)
// ========================================================
function cerrarSesion() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "/";
}

// ========================================================
// FUNCIÓN GLOBAL PARA PROTEGER RUTAS
// protegerRuta("admin")  → solo admin
// protegerRuta("usuario") → solo estudiante
// ========================================================
function protegerRuta(rolRequerido) {
    const usuarioStr = localStorage.getItem("usuario");

    if (!usuarioStr) {
        window.location.href = "/";
        return;
    }

    const usuario = JSON.parse(usuarioStr);

    if (rolRequerido === "admin" && usuario.rol !== "Administrador") {
        alert("Acceso denegado.");
        window.location.href = "/usuario/index";
        return;
    }

    if (rolRequerido === "usuario" && usuario.rol !== "Usuario") {
        alert("Acceso denegado.");
        window.location.href = "/admin/index";
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
