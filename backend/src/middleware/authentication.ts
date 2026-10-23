import type { NextFunction, Request, Response } from "express";

export function requireAuthentication(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!request.session.userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  next();
}
