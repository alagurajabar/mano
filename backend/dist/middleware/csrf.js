import { randomBytes, timingSafeEqual } from "node:crypto";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function provideCsrfToken(request, response) {
    request.session.csrfToken ??= randomBytes(32).toString("hex");
    response.json({ csrfToken: request.session.csrfToken });
}
export function verifyCsrfToken(request, response, next) {
    if (SAFE_METHODS.has(request.method)) {
        next();
        return;
    }
    const expected = request.session.csrfToken;
    const provided = request.get("x-csrf-token");
    if (!expected || !provided) {
        response.status(403).json({ error: "Invalid security token. Refresh and try again." });
        return;
    }
    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided);
    if (expectedBytes.length !== providedBytes.length ||
        !timingSafeEqual(expectedBytes, providedBytes)) {
        response.status(403).json({ error: "Invalid security token. Refresh and try again." });
        return;
    }
    next();
}
