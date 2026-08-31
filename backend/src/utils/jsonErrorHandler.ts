import express from 'express';

// A malformed request body is a client error, not a server one. Express's
// body-parser rejects unparseable JSON by calling next(err) with a SyntaxError
// tagged `type: 'entity.parse.failed'` (and `entity.too.large` when the body
// exceeds the configured limit). Mounted right after express.json(), this
// 4-arg error middleware turns those into 400/413 instead of letting them fall
// through to the generic 500 handler.
export function jsonBodyErrorHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err))) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  return next(err);
}
