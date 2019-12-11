import url from 'url';
import path from 'path';
import mime from 'mime';
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

  return rebuildRemainingRequest(loaders, resource);
  // const remainingRequest = rebuildRemainingRequest(loaders, resource);
  // return `require(${JSON.stringify(remainingRequest)})`;
}

function toNumber(item) {
  if (typeof item !== 'string') {
    return Number.NaN;
  }
  return Number(item);
}

async function createPlaceholderRequest(resource, size, lightweight, loaderReference) {
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
  const placeholderRequest = ['!', url.format(loaderOptions), resource].join('!');
  return new Promise((resolve, reject) => {
    loaderReference.loadModule(placeholderRequest, (err, source) => {
      if (err) return reject(err);
      return resolve(source.replace(/module\.exports\s*=\s*/, '').replace(/;$/, ''));
    });
  });
}

async function asyncForEach(items, callback) {
  if (!Array.isArray(items)) {
    return callback(items);
  }
  for (let index = 0; index < items.length; index += 1) {
    // eslint-disable-next-line
    await callback(items[index], index, items);
  }
  return true;
}

async function buildSources(sizes, loaders, loaderReference, resource) {
  const sources = {};

  await asyncForEach(sizes, async (size) => {
    if (size != null && size !== DEFAULT_SIZE && !/\d+w/.test(size)) {
      throw new TypeError(`pwa-srcset-loader: Received size "${size}" does not match the format "\\d+w" nor "${DEFAULT_SIZE}"`);
    }

    const actualSize = size || DEFAULT_SIZE;
    await new Promise((resolve, reject) => {
      loaderReference.loadModule(
        createResizeRequest(
          actualSize,
          loaders,
          resource(size),
        ), (err, source) => {
          if (err) return reject(err);
          sources[actualSize] = source
            .replace(/module.exports\s*=\s*/g, '')
            .replace(/export\s*default\s*/g, '')
            .replace(/;$/, '');
          return resolve(source);
        },
      );
    });
    // sources[actualSize] = createResizeRequest(actualSize, loaders, resource(size));
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

  throw new TypeError(`pwa-srcset-loader: "?sizes=${sizes}" is invalid - expected a query like "?sizes[]=<size>&sizes[]=..." or "?sizes=<size>+<size>+...".`);
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

async function createResourceObjectString(
  loaderQuery,
  sizes,
  loaders,
  resource,
  ext,
  placeholder,
  lightweight,
  loaderReference,
) {
  const contentType = mime.getType(ext);

  const transformResource = loaderQuery.transformResource || ((r, size) => `${r}?size=${size}`);

  const sources = await buildSources(
    sizes,
    loaders,
    loaderReference,
    ((size) => transformResource(resource, size)),
  );

  const srcSet = !lightweight
    ? `srcSet: ${stringifySrcSet(sources)},`
    : '';

  const placeholderScript = placeholder
    ? `placeholder: ${await createPlaceholderRequest(resource, placeholder, lightweight, loaderReference)},`
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
  const callback = this.async();

  const lightweight = isLightweight(loaderQuery, resourceQuery);
  if (typeof lightweight !== 'boolean') {
    throw new TypeError(`pwa-srcset-loader: "?lightweight=${lightweight}" is invalid - expected a boolean.`);
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
    return callback(null);
  }

  const [loaders, resource] = splitRemainingRequest(remainingRequest);
  const ext = path.extname(resource).substr(1);

  const self = this;

  return (async () => {
    let outputString = await createResourceObjectString(
      loaderQuery,
      sizes,
      loaders,
      resource,
      ext,
      placeholder,
      lightweight,
      self,
    );

    if (ext.toLowerCase() !== 'webp') {
      const wepbLoaders = loaders.slice(0);

      const fileLoader = this.loaders.find((e) => e.path.indexOf('file-loader') !== -1);
      if (fileLoader) {
        const fileLoaderIndex = wepbLoaders.findIndex((e) => {
          return e.indexOf('file-loader') !== -1;
        });

        let queryString = '';

        if (typeof fileLoader.options === 'string') {
          queryString = fileLoader.options;
          if (queryString.indexOf('[ext]') !== -1) {
            queryString = queryString.replace('[ext]', 'webp');
          } else {
            const nameMatch = queryString.match(/name=([^&]*)&?/);
            if (nameMatch && nameMatch.length >= 2) {
              queryString = queryString.replace(nameMatch[1], `${nameMatch[1]}.webp`);
            }
          }
        } else if (typeof fileLoader.options === 'object') {
          const options = {};
          Object.assign(options, fileLoader.options);
          if (options && options.name) {
            if (options.name.indexOf('[ext]') !== -1) {
              options.name = options.name.replace('[ext]', 'webp');
            } else {
              options.name += '.webp';
            }
          } else {
            options.name = '[name].webp';
          }
          queryString = JSON.stringify(options);
        }
        const newFileLoader = `${fileLoader.path}?${queryString}`;
        wepbLoaders.splice(fileLoaderIndex, 1, newFileLoader);
        wepbLoaders.push('webp-loader');
      }
      outputString = `${outputString}, ${await createResourceObjectString(
        loaderQuery,
        sizes,
        wepbLoaders,
        resource,
        'webp',
        placeholder,
        lightweight,
        self,
      )}`;
    }
    callback(null, `module.exports = [${outputString}];`);
  })();
};

// webpack pitch loaders expect commonJS
module.exports.pitch = srcSetLoader.pitch;
