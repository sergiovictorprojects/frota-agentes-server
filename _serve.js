const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.argv[2] || 8123;
const file = process.argv[3] || 'codigo-de-conduta-frota.html';

http.createServer((req, res) => {
  const filePath = path.join(__dirname, file);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end(String(err)); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(port, () => console.log('serving ' + file + ' on ' + port));
