import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../utils/env';
import { JWTPayload } from '../types';

export interface AuthRequest extends Request {
  user?: JWTPayload;
  // Explicitly re-declare Express Request properties so they are always
  // visible on AuthRequest regardless of how @types/express resolves in
  // the build environment.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  params: Record<string, string>;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, jwtSecret()) as JWTPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requirePremium(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.plan !== 'premium') {
    res.status(403).json({ error: 'This feature requires a Premium plan' });
    return;
  }
  next();
}
