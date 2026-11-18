// Maps well-known error types to the right HTTP status. Anything unexpected is a
// 500 whose details stay in the server log and are not sent to the client.
export function errorHandler(err, req, res, next) {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Internal Server Error';

    if (err.name === 'ValidationError') {
        // Mongoose schema validation
        status = 400;
        message = Object.values(err.errors || {}).map(e => e.message).join(', ') || 'Validation failed';
    } else if (err.name === 'CastError') {
        status = 400;
        message = `Invalid ${err.path || 'identifier'}`;
    } else if (err.name === 'MulterError') {
        status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${req.uploadLimitLabel || '25 MB'})` : `Upload error: ${err.message}`;
    } else if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        status = 400;
        message = 'Malformed JSON in request body';
    } else if (err.type === 'entity.too.large') {
        status = 413;
        message = 'Request body is too large';
    } else if (err.code === 11000) {
        status = 409;
        message = 'A record with this value already exists';
    } else if (typeof err.message === 'string' && err.message.startsWith('Unsupported file type')) {
        status = 400;
    }

    if (status >= 500) {
        console.error(err);
        if (process.env.NODE_ENV === 'production') message = 'Internal Server Error';
    }

    if (res.headersSent) return next(err);
    res.status(status).json({ success: false, error: { message } });
}
