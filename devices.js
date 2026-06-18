const { RtAudio } = require('audify');

const WASAPI_API = 7;
const audio = new RtAudio(WASAPI_API);

const devices = audio.getDevices();

for (const d of devices) {
  console.log('-----------------------------------');
  console.log(`ID: ${d.id}`);
  console.log(`Name: ${d.name}`);
  console.log(`Input channels: ${d.inputChannels}`);
  console.log(`Output channels: ${d.outputChannels}`);
  console.log(`Default input: ${d.isDefaultInput}`);
  console.log(`Default output: ${d.isDefaultOutput}`);
}