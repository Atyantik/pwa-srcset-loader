import { describe, it } from 'mocha';
import chai from 'chai';
import dirtyChai from 'dirty-chai';
import spies from 'chai-spies';
import { makeCompiler, runTest } from './util';

const { expect } = chai;

chai.use(spies);
chai.use(dirtyChai);

const FILE_TYPES = /\.(jpe?g|png|gif|svg)$/i;
const WHALE_IMG = './resources/whale.jpeg';
const TOR_IMG = './resources/tor-portrait.jpeg';

// matches the format
// ((<path>( <size>)?)(,|$))+
const SRC_SET_FORMAT = /^((?:[a-z0-9A-Z]+?\.(?:jpe?g|svg|png|gif|webp))(?: \d+[wx])?(,|$))+/;
const FILE_FORMAT = /^[a-z0-9A-Z]+?\.(?:jpe?g|svg|png|gif|webp)/;


function validateImgGeneric(img, lightweight = false) {
  if (lightweight) {
    expect(img.srcSet).to.be.undefined();
  } else {
    expect(img.srcSet).to.match(SRC_SET_FORMAT, 'Invalid srcSet syntax');
  }
  // eslint-disable-next-line
  for (const size of Object.keys(img.sources)) {
    expect(img.sources[size]).to.match(FILE_FORMAT, 'Invalid URL');
  }
}

function validatePlaceholder(placeholder, lightweight = false) {
  expect(placeholder.url).to.be.a('string');
  expect(placeholder.ratio).to.be.above(0, 'Ratio should be a float greater than zero');
  expect(placeholder.color).to.be.an('array', 'Color should be an array of 4 numbers.');
  expect(placeholder.color.length).to.equal(4, 'Color should be an array of 4 numbers.');
  for (let i = 0; i < 3; i += 1) {
    const channel = placeholder.color[i];
    expect(channel).to.be.a('number');
    expect(Number.isSafeInteger(channel)).to.equal(true, 'Not integer');
    expect(channel).to.be.within(0, 255);
  }
  expect(placeholder.color[3]).to.be.a('number');
  expect(placeholder.color[3]).to.be.within(0, 1, 'Alpha channel should be a float [0, 1]');
  if (lightweight) {
    expect(placeholder.url.startsWith('data:image/jpeg;base64,')).to.be.true('lightweight placeholders should not return the SVG wrapper.');
  } else {
    expect(placeholder.url.startsWith('data:image/svg+xml;base64,')).to.be.true('non-lightweight placeholders should return the SVG wrapper.');
  }
}


describe('Resource Query', () => {
  const RULE = {
    test: FILE_TYPES,
    use: [
      'pwa-srcset-loader',
      'file-loader',
    ],
  };

  it('none: returns the image without processing it and no placeholder', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}');`,
      },
      rule: RULE,
    });
    return runTest(compiler, async (window) => {
      const img = window.img.default ? window.img.default : window.img;
      expect(img).to.be.a('string');
      // expect(1).to.be.a('number');
    });
  });

  it('?placeholder: returns array of images without processing it, and a placeholder', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?placeholder');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;
      expect(img).to.be.an('array');
      img.forEach((image, i) => {
        expect(img[i]).to.be.an('object');
        // no size specified, return image with size default
        expect(Object.keys(img[i].sources)).to.deep.equal(['default']);
        validateImgGeneric(img[i]);
        validatePlaceholder(img[i].placeholder);
      });
    });
  });

  it('?placeholder: returns the correct ratio for a landscape image', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?placeholder');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;
      img.forEach((image) => {
        expect(image.placeholder.ratio).to.be.above(1, 'Aspect ratio for a landscape image should be greater than 1');
      });
    });
  });

  it('?placeholder: returns the correct ratio for a portrait image', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${TOR_IMG}?placeholder');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;
      img.forEach((image) => {
        expect(image.placeholder.ratio).to.be.above(0, 'Aspect ratio for a portrait image should be greater than 0');
        expect(image.placeholder.ratio).to.be.below(1, 'Aspect ratio for a portrait image should be less than 1');
      });
    });
  });

  it('?sizes: returns the resized images, and no placeholder', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?sizes[]=200w&sizes[]=300w');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;

      img.forEach((image) => {
        expect(image).to.be.an('object');
        expect(Object.keys(image.sources)).to.deep.equal(['200w', '300w']);
        validateImgGeneric(image);
        expect(image.placeholder).to.be.undefined();
      });
    });
  });

  it('?sizes: accepts the alternate syntax a+b+c', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?sizes=200w+300w');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;
      img.forEach((image) => {
        expect(image).to.be.an('object');
        expect(Object.keys(image.sources)).to.deep.equal(['200w', '300w']);
        validateImgGeneric(image);
        expect(image.placeholder).to.be.undefined();
      });
    });
  });

  it('?sizes: size "default" returns the default image, untouched', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?sizes=200w+300w+default');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;

      img.forEach((image) => {
        expect(image).to.be.an('object');
        expect(Object.keys(image.sources)).to.deep.equal(['200w', '300w', 'default']);
        validateImgGeneric(image);
        expect(image.placeholder).to.be.undefined();
      });
    });
  });

  it('?sizes&placeholder: returns both the resized images, and a placeholder', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?sizes=200w+300w&placeholder');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;

      img.forEach((image) => {
        expect(image).to.be.an('object');
        expect(Object.keys(image.sources)).to.deep.equal(['200w', '300w']);
        validateImgGeneric(image);
        validatePlaceholder(image.placeholder);
      });
    });
  });

  it('?lightweight: only returns data which cannot be built during runtime', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?placeholder&sizes=200w+300w&lightweight');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;

      img.forEach((image) => {
        expect(image).to.be.an('object');
        // no size specified, return image with size default
        expect(Object.keys(image.sources)).to.deep.equal(['200w', '300w']);
        validateImgGeneric(image, true);
        validatePlaceholder(image.placeholder, true);
      });
    });
  });

  it('?placeholder=[width]: accepts the placeholder size as value', () => {
    const compiler = makeCompiler({
      files: {
        'main.js': `window.img = require('${WHALE_IMG}?placeholder=12&lightweight');`,
      },
      rule: RULE,
    });

    return runTest(compiler, (window) => {
      const { img } = window;

      const promises = [];

      img.forEach((image) => {
        expect(image).to.be.an('object');
        // no size specified, return image with size default
        expect(Object.keys(image.sources)).to.deep.equal(['default']);
        validateImgGeneric(image, true);
        validatePlaceholder(image.placeholder, true);
        promises.push(new Promise((resolve, reject) => {
          const imgTag = new window.Image();
          imgTag.addEventListener('load', () => {
            console.log(imgTag.width);
            console.log(imgTag.height);
            resolve();
          });
          imgTag.onerror = function onError(e) {
            console.log(e);
            reject(e);
          };
          // img.setAttribute('src', image.placeholder.url);
          // console.log(image.placeholder.url);
          imgTag.src = image.placeholder.url;
          // if (image.placeholder.url.length > 20) {
          //   resolve();
          // }
        }));
      });
      return Promise.all(promises);
    });
  }).timeout(10000);
});
