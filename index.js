// VPS / Coolify entry point — starts an HTTP server
const app = require('./server');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n  Movy API running at http://localhost:${PORT}`);
  console.log(`  Docs:   http://localhost:${PORT}/`);
  console.log(`  Try:    http://localhost:${PORT}/api/movie/273207?server=miami\n`);
});
