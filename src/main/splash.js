// SmartDesk AI — Splash screen loader script
// External file avoids Electron CSP inline-script blocking

(function () {
  var statusEl   = document.getElementById('status-text');
  var progressEl = document.getElementById('progress-fill');
  var pctEl      = document.getElementById('progress-pct');

  if (!statusEl || !progressEl) return; // guard if DOM not ready

  var STAGES = [
    { pct: 8,   msg: 'Starting SmartDesk AI\u2026'           },
    { pct: 22,  msg: 'Loading IBM watsonx AI engine\u2026'   },
    { pct: 40,  msg: 'Initializing file classifier\u2026'    },
    { pct: 58,  msg: 'Preparing folder watcher\u2026'        },
    { pct: 74,  msg: 'Connecting to services\u2026'          },
    { pct: 88,  msg: 'Almost ready\u2026'                    },
    { pct: 100, msg: 'Welcome to SmartDesk AI!'              },
  ];

  var TOTAL_MS = 3200;
  var stepMs   = TOTAL_MS / STAGES.length;

  function setStage(pct, msg) {
    statusEl.textContent       = msg;
    progressEl.style.width     = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
  }

  // Kick off immediately with first stage
  setStage(STAGES[0].pct, STAGES[0].msg);

  for (var i = 1; i < STAGES.length; i++) {
    (function (stage, delay) {
      setTimeout(function () { setStage(stage.pct, stage.msg); }, delay);
    })(STAGES[i], i * stepMs);
  }
})();
