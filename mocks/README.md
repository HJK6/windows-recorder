# Local activation harness

Run `npm run mock:backend`, `npm run mock:flex`, and `npm start` in separate shells,
then open `http://127.0.0.1:8788`. The console uses fake `mock-flex-*` tokens and the
backend writes mock uploads and metadata beneath `mocks/backend/.data/`.

The recorder defaults to these endpoints. Override `FR_BACKEND_BASE_URL`,
`FR_CONTROL_PORT`, or `FR_ALLOWED_ORIGINS` to point at compatible services.
