const express = require('express');
const {
	spawn
} = require('child_process');
const app = express();
const dgram = require("dgram");

var fs = require('fs');

// all site-specific settings live in config.json
const config = require('./config.json');

const logFileName = config.logFileName;

// for rigctl
const port = config.port;
const bindAddr = config.bindAddr; // "0.0.0.0" = all interfaces, "127.0.0.1" = local only
const radio = config.radio; // hamlib model number, 2045 = Elecraft KX3
const device = config.device; // serial port (or host:port for rigctld)
const serialSpeed = config.serialSpeed; // must match the KX3 MENU:RS232 setting
const program = config.rigctlPath;

// for RUMlogNG
const N1MM_Addr = config.N1MM_Addr;
const N1MM_Port = config.N1MM_Port;

// one shared UDP socket, bound at startup so the broadcast flag is
// already set when the first QSO arrives
const udpSocket = dgram.createSocket("udp4");
udpSocket.bind(function() {
	udpSocket.setBroadcast(true);
});

const BW = {
	'CW': "300",
	'USB': "2500",
	'LSB': "2500"
};

// check for dupes 
// we use an array buffer with n (e.g. 10) spots. Whenever a new spot is added, the oldest is removed and the newest gets added
// When we are about to submit a spot, we check to see if a spot with identical data is already in the buffer.
var maxBuffer = 10;
var dupeBuffer = [];

function insertIntoBuffer(buffer, newElem) {
	// if we already have maxBuffer elements, then remove the last element
	if (buffer.length == maxBuffer) {
		buffer.pop();
	}
	// insert a copy of the new element at the beginning of the array
	buffer.unshift(Object.assign({}, newElem));
}

function compareLogEntry(e1, e2) {
	if (e1["call"] !== e2["call"])
		return false;
	else if (e1["entity"] !== e2["entity"])
		return false;
	else if (e1["qso_date"] !== e2["qso_date"])
		return false;
	else if (e1["time_on"] !== e2["time_on"])
		return false;
	else if (e1["mode"] !== e2["mode"])
		return false;
	else if (e1["freq"] !== e2["freq"])
		return false;
	return true;
}

function isInBuffer(buffer, elem) {
	for (var i = 0; i < buffer.length; i++) {
		if (compareLogEntry(buffer[i], elem) == true) {
			return true;
		}
	}
	return false;
}

function makeAdifData(qso) {
	var adif = "";
	for (const k in qso) {
		var v = qso[k];
		// fields without a value (e.g. no POTA ref, no comment) are skipped
		if (v == null || v === "") {
			continue;
		}
		v = String(v);
		adif = adif + "<" + k + ":" + v.length + ">" + v + " ";
	}
	adif = adif + "<eor>";
	return adif;
}

// runs rigctl and resolves with { ok, resp, err } - never rejects, so
// callers can't crash the server by forgetting a catch
function callRigCtrl(cmd) {
	return new Promise(function(resolve) {
		var resp = "";
		var errOut = "";
		cmd = cmd.trim();
		var args = "-m " + radio + " -r " + device + " -s " + serialSpeed + " " + cmd;
		// console.log('ARGS: ' + args);
		args = args.trim().split(" ");

		var child = spawn(program, args);

		child.on("error", function(e) {
			console.log("rigctl spawn error: " + e);
			resolve({ ok: false, resp: "", err: String(e) });
		});

		child.stdout.on("data", function(data) {
			resp = resp + data.toString("utf8");
		});

		child.stderr.on("data", function(data) {
			errOut = errOut + data.toString("utf8");
		});

		child.on("close", function(code) {
			resp = resp.replace("\r", " ").replace("\n", " ").replace("  ", " ").trim();
			if (code !== 0) {
				console.log("rigctl failed (exit " + code + "): " + errOut.trim());
			}
			resolve({ ok: code === 0, resp: resp, err: errOut.trim() });
		});
	});
}

// use OmniRig syntax to control rig:
// # http://localhost:8073/omnirig/qsy?freq=7200000&mode=LSB

app.get('/omnirig/qsy', async function(req, res) {
	console.log("OMNIRIG (QSY) - Received: " + JSON.stringify(req.query));
	var freq = parseInt(req.query.freq, 10);
	var mode = (req.query.mode || "").toUpperCase();

	if (!freq || freq <= 0 || mode === "") {
		console.log("QSY: invalid freq or mode");
		res.status(400).send("Invalid or missing freq/mode");
		return;
	}
	// modes not in the BW table use passband 0 = rig default
	var bw = BW[mode] || "0";
	// console.log("Found QSY: " + freq + " " + mode);
	// set frequency and mode in a single rigctl call - two concurrent
	// rigctl processes collide on the serial port
	var result = await callRigCtrl("F " + freq + " M " + mode + " " + bw);
	if (result.ok) {
		res.send("OK");
	} else {
		res.status(500).send("rigctl failed: " + result.err);
	}
});


// use Log4OM for logging
// http://localhost:8073/log4om/log?CALL=P5DX&RST_SENT=599&RST_RCVD=599&FREQ=1.84027&BAND=160M&MODE=CW&QSO_DATE=20170515&TIME_ON=210700&STATION_CALLSIGN=AA6YQ&TX_PWR=1500

app.get('/log4om/log', function(req, res) {
	console.log("Log4OM (logging) - Received: " + JSON.stringify(req.query));

	// the POTA award reference is optional - a QSO without one (or with a
	// malformed one) is still logged, just without park/state info
	var potaRef;
	var state;
	try {
		var addData = JSON.parse(req.query.APP_L4ONG_QSO_AWARD_REFERENCES);
		potaRef = addData[0]["R"];
		var regionRaw = addData[0]["G"];
		state = regionRaw.split(',')[0].split('-')[1];
	} catch (e) {
		console.log("No usable POTA award reference, logging without park info (" + e + ")");
	}

	var qso = {
		"call": req.query.CALL,
		"qso_date": req.query.QSO_DATE,
		"time_on": req.query.TIME_ON,
		"freq": req.query.FREQ,
		"mode": req.query.MODE,
		"rst_sent": req.query.RST_SENT,
		"rst_rcvd": req.query.RST_RCVD,
		"state": state,
		"qth": potaRef,
		"comment": req.query.COMMENT,
		"tx_pwr": req.query.TX_PWR,
		"sig_info": potaRef
	};

	// is this element already in the buffer? 
	console.log("BUFFER: " + JSON.stringify(dupeBuffer));
	if (isInBuffer(dupeBuffer, qso)) {
		console.log("ignoring DUPE");
		res.send("DUPE");
	} else {
		// insert the new entry in the buffer 
		insertIntoBuffer(dupeBuffer, qso);

		var msgRaw = makeAdifData(qso);
		// There is _NO_ space between Log and <parameters!!! 
		// For this to work, RUMlogNG needs to be configured to accept "QSOs received from Flex radio" - this can 
		// either be set to "Save QSO" or to "Fill fields". In the latter case, the user needs to fill in other potential
		// information and then click on the log button. 
		var msg = "<command:3>Log<parameters:" + msgRaw.length + "> " + msgRaw;

		// append the plain ADIF record (without the N1MM wrapper) to the log
		// file, so it can be imported into a logging program as-is
		fs.appendFile(logFileName, msgRaw + "\n", function(err) {
			if (err) {
				console.error("log file error: " + err);
			}
		});

		var message = Buffer.from(msg);
		udpSocket.send(message, 0, message.length, N1MM_Port, N1MM_Addr, function(err, bytes) {
			if (err) {
				console.log("UDP send error: " + err);
			}
		});
		res.send("OK");
	}
});

app.get('/log4om/ping', function(req, res) {
        console.log("Log4OM (ping - get) - query: " + JSON.stringify(req.query));
        console.log("Log4OM (ping - get) - params: " + JSON.stringify(req.params));
//        console.log("Log4OM (ping) - Received: " + JSON.stringify(req));
	// res.sendStatus(200);
	res.send("PING tcp, localhost, 8073");
});

app.post('/log4om/ping', function(req, res) {
        console.log("Log4OM (ping - post) - query: " + JSON.stringify(req.query));
        console.log("Log4OM (ping - post) - params: " + JSON.stringify(req.params));
//        console.log("Log4OM (ping) - Received: " + JSON.stringify(req));
	// res.sendStatus(200);
	res.send("PING tcp, localhost, 8073");
});

// We don't need this, but it makes for an simple test to see if the app is running
app.get('/', function(req, res) {
	res.send(`PotaPlus Connector - Listening on port ${port}!`);
});

app.listen(port, bindAddr, function() {
	console.log(`PotaPlus Connector - Listening on ${bindAddr}:${port}!`);
});
