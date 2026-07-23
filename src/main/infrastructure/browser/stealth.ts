/**
 * 外部浏览器反自动化检测（Stealth）& 指纹唯一化
 *
 * 1. 伪造真实 Chrome User-Agent
 * 2. 基于窗口 seed 生成唯一且一致的浏览器指纹
 *    - Canvas 指纹 (toDataURL / getImageData)
 *    - WebGL 参数（renderer / vendor / unmasked）
 *    - AudioContext 指纹
 *    - ClientRects 微偏移
 *    - navigator.hardwareConcurrency / deviceMemory
 *    - screen 分辨率
 * 3. 反 webdriver / CDP 检测
 */

/** 生成一个伪造的真实 Chrome User-Agent */
export function generateChromeUA(): string {
  // 主版本 120-132，随机 patch
  const major = 120 + Math.floor(Math.random() * 13)
  const build = 6000 + Math.floor(Math.random() * 400)
  const patch = Math.floor(Math.random() * 200)
  const chromeVer = `${major}.0.${build}.${patch}`
  const platform =
    process.platform === 'darwin'
      ? `Macintosh; Intel Mac OS X 10_15_${7 + Math.floor(Math.random() * 3)}`
      : process.platform === 'win32'
        ? `Windows NT 10.0; Win64; x64`
        : `X11; Linux x86_64`
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
}

/** 生成唯一的窗口指纹 seed（同一窗口生命周期内保持不变） */
export function generateFingerprintSeed(): string {
  // 32 位十六进制字符串
  let s = ''
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16)
  }
  return s
}

/**
 * 构造 stealth + 指纹注入脚本。
 * @param seed 窗口指纹 seed，保证同窗口内所有页面指纹一致
 * @param ua   伪造的 User-Agent
 */
export function buildStealthJS(seed: string, ua: string): string {
  return `
(function(){
  if (window.__stealth_applied__) return;
  window.__stealth_applied__ = true;

  // ── 基于 seed 的确定性伪随机数生成器（同 seed 永远相同序列）──
  var SEED = ${JSON.stringify(seed)};
  var _idx = 0;
  function seedRand() {
    var h = 0;
    var s = SEED + ':' + (_idx++);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (((h >>> 0) % 10000) / 10000);
  }

  // ── 1. navigator.webdriver ──
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true,
  });

  // ── 2. User-Agent 一致性 ──
  var FAKE_UA = ${JSON.stringify(ua)};
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: function() { return FAKE_UA; }, configurable: true,
    });
    Object.defineProperty(navigator, 'appVersion', {
      get: function() { return FAKE_UA.slice(FAKE_UA.indexOf('/') + 1); }, configurable: true,
    });
  } catch(e){}

  // ── 3. window.chrome ──
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onMessage: { addListener: function(){}, removeListener: function(){} },
      sendMessage: function(){},
      connect: function(){ return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
    };
  }
  if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
  if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };

  // ── 4. navigator.plugins ──
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      var a = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      a.refresh = function(){};
      a.item = function(i){ return a[i] || null; };
      a.namedItem = function(n){ return a.find(function(p){ return p.name === n; }) || null; };
      return a;
    }, configurable: true,
  });

  // ── 5. navigator.mimeTypes ──
  Object.defineProperty(navigator, 'mimeTypes', {
    get: function() {
      return [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
    }, configurable: true,
  });

  // ── 6. navigator.languages ──
  Object.defineProperty(navigator, 'languages', {
    get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; },
    configurable: true,
  });

  // ── 7. navigator.hardwareConcurrency（seed 决定，4-16）──
  var _cores = 4 + Math.floor(seedRand() * 13);
  _cores = _cores % 2 === 0 ? _cores : _cores + 1; // 保持偶数
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: function() { return _cores; }, configurable: true,
  });

  // ── 8. navigator.deviceMemory（seed 决定，4/8/16）──
  var _memArr = [4, 8, 8, 16];
  var _mem = _memArr[Math.floor(seedRand() * _memArr.length)];
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() { return _mem; }, configurable: true,
    });
  } catch(e){}

  // ── 9. navigator.platform ──
  try {
    var _plat = ${JSON.stringify(
      process.platform === 'darwin'
        ? 'MacIntel'
        : process.platform === 'win32'
          ? 'Win32'
          : 'Linux x86_64'
    )};
    Object.defineProperty(navigator, 'platform', {
      get: function() { return _plat; }, configurable: true,
    });
  } catch(e){}

  // ── 10. screen 分辨率（固定 1920x1080）──
  var _scr = [1920, 1080];
  try {
    Object.defineProperty(screen, 'width', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'height', { get: function(){ return _scr[1]; } });
    Object.defineProperty(screen, 'availWidth', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'availHeight', { get: function(){ return _scr[1] - 40; } });
    Object.defineProperty(screen, 'colorDepth', { get: function(){ return 24; } });
    Object.defineProperty(screen, 'pixelDepth', { get: function(){ return 24; } });
  } catch(e){}

  // ── 11. Canvas 指纹（在像素数据中加入 seed 决定的微量噪声）──
  try {
    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    // 给 ImageData 的像素加微量噪声（seed 决定，同 seed 同结果）
    function _noiseImageData(imageData) {
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        // 每 100 个像素扰动一次，幅度 ±1
        if (i % 400 === 0) {
          var n = ((seedRand() * 3) | 0) - 1; // -1, 0, 1
          d[i] = Math.max(0, Math.min(255, d[i] + n));
        }
      }
      return imageData;
    }

    CanvasRenderingContext2D.prototype.getImageData = function() {
      var data = _origGetImageData.apply(this, arguments);
      return _noiseImageData(data);
    };
    HTMLCanvasElement.prototype.toDataURL = function() {
      // 在导出前注入噪声像素
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){} // 跨域 canvas 会报错，忽略
      }
      return _origToDataURL.apply(this, arguments);
    };
    HTMLCanvasElement.prototype.toBlob = function() {
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){}
      }
      return _origToBlob.apply(this, arguments);
    };
  } catch(e){}

  // ── 12. WebGL 指纹（伪造 renderer / vendor / unmasked 信息）──
  try {
    var _glRenderers = [
      'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
      'ANGLE (AMD, AMD Radeon Pro 5500M, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
      'ANGLE (Apple, Apple M1, OpenGL 4.1)',
      'ANGLE (Apple, Apple M2, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) UHD Graphics 770, OpenGL 4.5)',
    ];
    var _glVendors = ['Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Google Inc. (Apple)'];
    var _myRenderer = _glRenderers[Math.floor(seedRand() * _glRenderers.length)];
    var _myVendor = _glVendors[Math.floor(seedRand() * _glVendors.length)];

    var _origGetParam = WebGLRenderingContext.prototype.getParameter;
    function _fakeGetParam(param) {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      if (param === 0x9245) return _myVendor;
      if (param === 0x9246) return _myRenderer;
      return _origGetParam.call(this, param);
    }
    WebGLRenderingContext.prototype.getParameter = _fakeGetParam;
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) return _myVendor;
        if (param === 0x9246) return _myRenderer;
        return _origGetParam2.call(this, param);
      };
    }
  } catch(e){}

  // ── 13. AudioContext 指纹噪声 ──
  try {
    var _origCreateOsc = (window.AudioContext || window.webkitAudioContext).prototype.createOscillator;
    var _origCreateDyn = (window.AudioContext || window.webkitAudioContext).prototype.createDynamicsCompressor;
    if (_origCreateDyn) {
      var _OrigAC = window.AudioContext || window.webkitAudioContext;
      var _origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
        _origGetFloat.call(this, arr);
        // 加微量噪声
        for (var i = 0; i < arr.length; i += 10) {
          arr[i] = arr[i] + (seedRand() - 0.5) * 0.001;
        }
      };
    }
  } catch(e){}

  // ── 14. ClientRects 微偏移（seed 决定的亚像素偏移）──
  try {
    var _origGetBCR = Element.prototype.getBoundingClientRect;
    var _origGetCR = Element.prototype.getClientRects;
    var _rectNoise = (seedRand() - 0.5) * 0.5; // -0.25 ~ +0.25
    Element.prototype.getBoundingClientRect = function() {
      var r = _origGetBCR.call(this);
      return new DOMRect(r.x + _rectNoise, r.y + _rectNoise, r.width, r.height);
    };
    Element.prototype.getClientRects = function() {
      var rects = _origGetCR.call(this);
      var out = [];
      for (var i = 0; i < rects.length; i++) {
        out.push(new DOMRect(rects[i].x + _rectNoise, rects[i].y + _rectNoise, rects[i].width, rects[i].height));
      }
      return out;
    };
  } catch(e){}

  // ── 15. navigator.permissions.query ──
  try {
    if (navigator.permissions) {
      var _origPQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(p) {
        if (p.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null });
        return _origPQ(p);
      };
    }
  } catch(e){}

  // ── 16. Function.prototype.toString ──
  var _ots = Function.prototype.toString;
  var _fts = function() {
    if (this === _fts) return 'function toString() { [native code] }';
    return _ots.call(this);
  };
  Function.prototype.toString = _fts;

  // ── 17. document.hidden / visibilityState ──
  try {
    Object.defineProperty(document, 'hidden', { get: function(){ return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function(){ return 'visible'; }, configurable: true });
  } catch(e){}

  // ── 18. connection.rtt 一致性 ──
  try {
    if (navigator.connection) {
      var _rtt = [50, 100, 150][Math.floor(seedRand() * 3)];
      Object.defineProperty(navigator.connection, 'rtt', { get: function(){ return _rtt; } });
    }
  } catch(e){}

})();
`
}
