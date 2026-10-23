export function requireAuthentication(request, response, next) {
    if (!request.session.userId) {
        response.status(401).json({ error: "Authentication required." });
        return;
    }
    next();
}
