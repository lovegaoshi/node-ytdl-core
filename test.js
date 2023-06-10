const ytdl = require('./lib/index');

ytdl.getInfo('https://music.youtube.com/watch?v=7EJbFg_LxjY')
.then(val => console.log((ytdl.chooseFormat(val.formats, {quality: 'highestaudio'})).url));