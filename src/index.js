import url from 'url';
import path from 'path';
import mime from "mime";
import _ from "lodash";
import { parseQuery } from './util';

const DEFAULT_SIZE = 'default';

function removeResourceQuery(resource) {
  return resource.split('?')[0];
}

function splitRemainingRequest(remainingRequest) {
  const split = remainingRequest.split('!');
  const rawResource = split.pop();
  const resource = removeResourceQuery(rawResource);
  return [split, resource];
}

function rebuildRemainingRequest(loaders, resource) {
  return `-!${[...loaders, resource].join('!')}`;
}

function buildResizeLoader(rawSize) {
  const size = parseInt(rawSize, 10);

  return url.format({
    pathname: path.join(__dirname, './resize-loader'),
    query: { size },
  });
}

function createResizeRequest(size, existingLoaders, resource) {
  const loaders = size === DEFAULT_SIZE
    ? existingLoaders
    : [...existingLoaders, buildResizeLoader(size)];

  const remainingRequest = rebuildRemainingRequest(loaders, resource);
  return `require(${JSON.stringify(remainingRequest)})`;
}

function createPlaceholderRequest(resource, size, lightweight) {
  const loaderOptions = {
    pathname: path.join(__dirname, './placeholder-loader'),
    query: {
      lightweight,
    },
  };

  const actualSize = toNumber(size);
  if (!Number.isNaN(actualSize)) {
    loaderOptions.query.size = actualSize;
  }

  return `require('!!${url.format(loaderOptions)}!${resource}')`;
}

function toNumber(item) {
  if (typeof item !== 'string') {
    return Number.NaN;
  }

  return Number(item);
}

function forEach(items, cb) {
  if (Array.isArray(items)) {
    return items.forEach(cb);
  }

  return cb(items);
}

function buildSources(sizes, loaders, resource) {  
  const sources = {};

  forEach(sizes, (size) => {
    if (size != null && size !== DEFAULT_SIZE && !/\d+w/.test(size)) {
      throw new TypeError(`srcset-loader: Received size "${size}" does not match the format "\\d+w" nor "${DEFAULT_SIZE}"`);
    }

    const actualSize = size || DEFAULT_SIZE;
    sources[actualSize] = createResizeRequest(actualSize, loaders, resource(size));
  });

  return sources;
}

function stringifySources(sources) {
  return `
{
  ${Object.keys(sources).map((source) => {
    return `"${source}": ${sources[source]}`;
  }).join(',\n')}
}
`;
}

function stringifySrcSet(sources) {
  return Object.keys(sources).map((size) => {
    if (size === 'default') {
      return `${sources[size]}`;
    }

    return `${sources[size]} + " ${size}"`;
  }).join('+","+');
}

function getSizes(sizes) {
  if (sizes == null || Array.isArray(sizes)) {
    return sizes;
  }

  if (typeof sizes === 'string') {
    return sizes.split('+');
  }

  throw new TypeError(`srcset-loader: "?sizes=${sizes}" is invalid - expected a query like "?sizes[]=<size>&sizes[]=..." or "?sizes=<size>+<size>+...".`);
}

function isLightweight(loaderQuery, resourceQuery) {
  if (loaderQuery.lightweight !== undefined) {
    return loaderQuery.lightweight;
  }

  if (resourceQuery.lightweight !== undefined) {
    return resourceQuery.lightweight;
  }

  return false;
}

function createResourceObjectString(loaderQuery, sizes, loaders, resource, ext, placeholder, lightweight) {

  const contentType = mime.getType(ext);

  const transformResource = loaderQuery.transformResource || ((resource, size) => resource + '?size=' + size)

  const sources = buildSources(sizes, loaders, (size => transformResource(resource, size)));

  const srcSet = !lightweight
    ? `srcSet: ${stringifySrcSet(sources)},`
    : '';

  const placeholderScript = placeholder
    ? `placeholder: ${createPlaceholderRequest(resource, placeholder, lightweight)},`
    : '';
  return `{
    sources: ${stringifySources(sources)},
    type: ${JSON.stringify(contentType)},
    ${srcSet}
    ${placeholderScript}
  }`;
}

export default function srcSetLoader(content) {
  return content;
}

srcSetLoader.pitch = function srcSetLoaderPitch(remainingRequest) {
  const loaderQuery = parseQuery(this.query);
  const resourceQuery = parseQuery(this.resourceQuery);

  const lightweight = isLightweight(loaderQuery, resourceQuery);
  if (typeof lightweight !== 'boolean') {
    throw new TypeError(`srcset-loader: "?lightweight=${lightweight}" is invalid - expected a boolean.`);
  }

  // check it isn't undefined so the resource can disable the loader configuration with `false`.
  const placeholder = resourceQuery.placeholder !== undefined
    ? resourceQuery.placeholder
    : loaderQuery.placeholder;

  // sizes can be falsy,
  // it will just return the original image along with the placeholder if requested.
  const sizes = getSizes(resourceQuery.sizes !== undefined
    ? resourceQuery.sizes
    : loaderQuery.sizes);

  // neither is requested, no need to run this loader.
  if (!placeholder && !sizes) {
    return undefined;
  }

  const [loaders, resource] = splitRemainingRequest(remainingRequest);
  const ext = path.extname(resource).substr(1);

  let outputString = createResourceObjectString(
    loaderQuery, 
    sizes, 
    loaders, 
    resource,
    ext, 
    placeholder, 
    lightweight
  );
  
  if (ext.toLowerCase() !== "webp") {
    let wepbLoaders = loaders.slice(0);
    let fileLoader = _.find(wepbLoaders, loader => {
      return loader.indexOf("file-loader") >=0 ;
    });
    let fileLoaderIndex = _.findIndex(wepbLoaders, loader => {
      return loader.indexOf("file-loader") >=0 ;
    });
    let webpLoader = null;

    if (!fileLoader) {
     fileLoader = "file-loader?name=[hash].[ext].ext";
     webpLoader = "webp-loader?quality=80";
     wepbLoaders.push(fileLoader);
     wepbLoaders.push(webpLoader); 
    } else {
      let nameMatch = fileLoader.match(/name=([^&]*)&?/);
      if ( nameMatch && nameMatch.length >=2 ){
        wepbLoaders.splice(fileLoaderIndex, 1, fileLoader.replace(nameMatch[1], `${nameMatch[1]}.webp`));
        webpLoader = "webp-loader?{quality:80}";
      }
    }
    if (webpLoader) {
      wepbLoaders.push(webpLoader);
    }
    outputString = `${outputString}, ${createResourceObjectString(
      loaderQuery, 
      sizes, 
      wepbLoaders, 
      resource,
      "webp", 
      placeholder, 
      lightweight
    )}`;
  }

  return `module.exports = [${outputString}];`;
};

// webpack pitch loaders expect commonJS
module.exports.pitch = srcSetLoader.pitch;
