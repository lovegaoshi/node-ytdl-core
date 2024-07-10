/* eslint-disable no-new-func */
// const querystring = require('querystring');
import querystring from 'query-string';
const Cache = require('./cache');
const utils = require('./utils');

let nTransformWarning = false;

// A shared cache to keep track of html5player js functions.
exports.cache = new Cache();

/**
 * Extract signature deciphering and n parameter transform functions from html5player file.
 *
 * @param {string} html5playerfile
 * @param {Object} options
 * @returns {Promise<Array.<string>>}
 */
exports.getFunctions = (html5playerfile, options) => exports.cache.getOrSet(html5playerfile, async() => {
  const body = await utils.exposedMiniget(html5playerfile, options).text();
  const functions = exports.extractFunctions(body);
  if (!functions || !functions.length) {
    throw Error('Could not extract functions');
  }
  exports.cache.set(html5playerfile, functions);
  return functions;
});

// eslint-disable-next-line max-len
// https://github.com/TeamNewPipe/NewPipeExtractor/blob/41c8dce452aad278420715c00810b1fed0109adf/extractor/src/main/java/org/schabi/newpipe/extractor/services/youtube/extractors/YoutubeStreamExtractor.java#L816
const DECIPHER_REGEXPS = [
  "\\bm=([a-zA-Z0-9$]{2,})\\(decodeURIComponent\\(h\\.s\\)\\)",
  "\\bc&&\\(c=([a-zA-Z0-9$]{2,})\\(decodeURIComponent\\(c\\)\\)",
  '(?:\\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2,})\\s*=\\s*function\\(\\s*a\\s*\\)\\s*\\{\\s*a\\s*=\\s*a\\.split\\(\\s*""\\s*\\)',
  '([\\w$]+)\\s*=\\s*function\\((\\w+)\\)\\{\\s*\\2=\\s*\\2\\.split\\(""\\)\\s*;',
];

const DECIPHER_ARGUMENT = 'sig';
const N_ARGUMENT = 'ncode';

const matchGroup1 = (regex, str) => {
  const match = str.match(new RegExp(regex));
  if (!match) throw new Error(`Could not match ${regex}`);
  return match[1];
};

const getFuncName = (body, regexps) => {
  try {
    let fn;
    for (const regex of regexps) {
      try {
        fn = matchGroup1(regex, body);
        const idx = fn.indexOf('[0]');
        if (idx > -1) fn = matchGroup1(`${fn.slice(0, 3)}=\\[([a-zA-Z0-9$\\[\\]]{2,})\\]`, body);
      } catch (err) {
        continue;
      }
    }
    if (!fn || fn.includes('[')) throw Error("Couldn't find fn name");
    return fn;
  } catch (e) {
    throw Error(`Please open an issue on ytdl-core GitHub: ${e.message}`);
  }
};

const getDecipherFuncName = body => getFuncName(body, DECIPHER_REGEXPS);

const matchRegex = (regex, str) => {
  const match = str.match(new RegExp(regex, "s"));
  if (!match) throw new Error(`Could not match ${regex}`);
  return match;
};

const matchFirst = (regex, str) => matchRegex(regex, str)[0];

const N_TRANSFORM_REGEXP =
  "function\\(\\s*(\\w+)\\s*\\)\\s*\\{" +
  'var\\s*(\\w+)=(?:\\1\\.split\\(""\\)|String\\.prototype\\.split\\.call\\(\\1,""\\)),' +
  "\\s*(\\w+)=(\\[.*?]);\\s*\\3\\[\\d+]" +
  "(.*?try)(\\{.*?})catch\\(\\s*(\\w+)\\s*\\)\\s*\\" +
  '{\\s*return"enhanced_except_([A-z0-9-]+)"\\s*\\+\\s*\\1\\s*}' +
  '\\s*return\\s*(\\2\\.join\\(""\\)|Array\\.prototype\\.join\\.call\\(\\2,""\\))};';

/**
 * Extracts the actions that should be taken to decipher a signature
 * and tranform the n parameter
 *
 * @param {string} body
 * @returns {Array.<string>}
 */
exports.extractFunctions = body => {
  // body = body.replace(/\n|\r/g, '');
  const functions = [];
  // This is required function, so we can't continue if it's not found.
  const extractDecipher = () => {
    const decipherFuncName = getDecipherFuncName(body);
    try {
      const functionPattern = `(${decipherFuncName.replace(/\$/g, '\\$')}=function\\([a-zA-Z0-9_]+\\)\\{.+?\\})`;
      const decipherFunction = `var ${matchGroup1(functionPattern, body)};`;
      const helperObjectName = matchGroup1(';([A-Za-z0-9_\\$]{2,})\\.\\w+\\(', decipherFunction)
        .replace(/\$/g, '\\$');
      const helperPattern = `(var ${helperObjectName}=\\{[\\s\\S]+?\\}\\};)`;
      const helperObject = matchGroup1(helperPattern, body);
      const callerFunction = `${decipherFuncName}(${DECIPHER_ARGUMENT});`;
      const resultFunction = helperObject + decipherFunction + callerFunction;
      functions.push(resultFunction);
    } catch (err) {
      throw Error(`Could not parse decipher function: ${err}`);
    }
  };
  // This is optional, so we can continue if it's not found, but it will bottleneck the download.
  const extractNTransform = () => {
    try {
      const N_TRANSFORM_FUNC_NAME = "DisTubeNTransformFunc";
      const nFunc = matchFirst(N_TRANSFORM_REGEXP, body);
      const resultFunc = `var ${N_TRANSFORM_FUNC_NAME}=${nFunc}`;
      const callerFunc = `${N_TRANSFORM_FUNC_NAME}(${N_ARGUMENT});`;
      functions.push(resultFunc + callerFunc);
    } catch (e) {
        console.warn(
          "Could not parse n transform function, please report it on @distube/ytdl-core GitHub."
        );
        console.warn(e)
        nTransformWarning = true;
    }

  };
  extractDecipher();
  extractNTransform();
  return functions;
};

/**
 * Apply decipher and n-transform to individual format
 *
 * @param {Object} format
 * @param {vm.Script} decipherScript
 * @param {vm.Script} nTransformScript
 */
exports.setDownloadURL = (format, decipherScript, nTransformScript) => {
  const decipher = url => {
    const args = querystring.parse(url);
    if (!args.s) return args.url;
    const components = new URL(decodeURIComponent(args.url));
    const context = {};
    context[DECIPHER_ARGUMENT] = decodeURIComponent(args.s);
    components.searchParams.set(args.sp || 'sig', decipherScript(args.s));
    return components.toString();
  };
  const nTransform = url => {
    const components = new URL(decodeURIComponent(url));
    const n = components.searchParams.get('n');
    if (!n || !nTransformScript) return url;
    const context = {};
    context[N_ARGUMENT] = n;
    components.searchParams.set('n', nTransformScript(n));
    return components.toString();
  };
  const cipher = !format.url;
  const url = format.url || format.signatureCipher || format.cipher;
  format.url = cipher ? nTransform(decipher(url)) : nTransform(url);
  delete format.signatureCipher;
  delete format.cipher;
};

/**
 * Adds a return phrase in an eval string to be properly used in new Function.
 * @param {string} functionString
 * @returns {string} parsedString
 */
const functionEvalWrapper = functionString => {
  const lastSemicolon = functionString.lastIndexOf(';', functionString.length - 2);
  return `${functionString.substring(0, lastSemicolon + 1)}return ${functionString.substring(lastSemicolon + 1)}`;
};

/**
 * Applies decipher and n parameter transforms to all format URL's.
 *
 * @param {Array.<Object>} formats
 * @param {string} html5player
 * @param {Object} options
 */
exports.decipherFormats = async(formats, html5player, options) => {
  let decipheredFormats = {};
  let functions = await exports.getFunctions(html5player, options);
  // console.log(functions[0])
  const decipherScript = functions.length ? new Function(['sig'], functionEvalWrapper(functions[0])) : null;
  // console.log(functions[1])
  const nTransformScript = functions.length > 1 ? new Function(['ncode'], functionEvalWrapper(functions[1])) : null;
  formats.forEach(format => {
    exports.setDownloadURL(format, decipherScript, nTransformScript);
    decipheredFormats[format.url] = format;
  });
  return decipheredFormats;
};
