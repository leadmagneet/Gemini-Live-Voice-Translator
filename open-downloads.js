const { exec } = require('child_process');

const urls = [
  'https://vb-audio.com/Cable/index.htm',
  'https://vb-audio.com/Voicemeeter/',
];

for (const url of urls) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}