// just for debugging:
const toSource = require('tosource');

const express = require('express');
const {
	spawn
} = require('child_process');
const app = express();
const dgram = require("dgram");

var fs = require('fs');


const logFileName = "./adif.log";

// for rigctl
const port = 8073;
const radio = "2";
const device = "10.0.1.5:4532";
const program = "/usr/local/bin/rigctl";

// for RUMlogNG
const N1MM_Addr = "10.0.1.255";
const N1MM_Port = 5555;

const timer = ms => new Promise(res => setTimeout(res, ms));

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
	for (k in qso) {
		var newTag = "";
		try {
			// get the associated value
			// console.log("ADIF: Creating data for " + k);
			var v = qso[k];
			newTag = "<" + k + ":" + v.length + ">" + v;
		} catch (e) {
			console.log("ADIF: Error for tag " + k + " - " + e);
		}
		if (newTag.length > 0) {
			adif = adif + newTag + " ";
		}
	}
	adif = adif + "<eor>";
	return adif;
}

function callRigCtrl(cmd) {
	var resp = "";
	cmd = cmd.trim();
	var args = "-m " + radio + " -r " + device + " " + cmd;
	// console.log('ARGS: ' + args);
	args = args.trim();

	args = args.split(" ");

	child = spawn(program, args);

	child.stdout.on("data", function(data) {
		data = data.toString("utf8");
		resp = resp + data;
	});

	child.stderr.on("data", function(data) {
		// console.log(data.toString("utf8"));
	});

	child.on("close", function() {
		resp = resp.replace("\r", " ").replace("\n", " ").replace("  ", " ").trim();
		// console.log("RESP: " + resp);
	});
}

// use OmniRig syntax to control rig:
// # http://localhost:8073/omnirig/qsy?freq=7200000&mode=LSB

app.get('/omnirig/qsy', function(req, res) {
	console.log("OMNIRIG (QSY) - Received: " + toSource(req.query));
	var freq = req.query.freq;
	var mode = req.query.mode;

	if (freq == 0 || mode == null) {
		console.log("Received NULL data");
		return;
	}
	// console.log("Found QSY: " + freq + " " + mode);
	callRigCtrl("F " + freq);

	// sleep 250ms and execute the next call
	timer(250);
	callRigCtrl("M " + mode.toUpperCase() + " " + BW[mode.toUpperCase()]);
});


// use Log4OM for logging
// http://localhost:8073/log4om/log?CALL=P5DX&RST_SENT=599&RST_RCVD=599&FREQ=1.84027&BAND=160M&MODE=CW&QSO_DATE=20170515&TIME_ON=210700&STATION_CALLSIGN=AA6YQ&TX_PWR=1500

app.get('/log4om/log', function(req, res) {
	console.log("Log4OM (logging) - Received: " + toSource(req.query));

	var addData = JSON.parse(req.query.APP_L4ONG_QSO_AWARD_REFERENCES);
	var potaRef = addData[0]["R"];
	var regionRaw = addData[0]["G"];
	var state = regionRaw.split(',')[0].split('-')[1];

	var qso = {
		"call": req.query.CALL,
		"qso_date": req.query.QSO_DATE,
		"time_on": req.query.TIME_ON,
		"freq": req.query.FREQ,
		"mode": req.query.MODE,
		"rst_sent": req.query.RST_SENT,
		"rst_rcvd": req.query.RST_RCVD,
		"state": state,
		"qth": addData[0]["R"],
		"comment": req.query.COMMENT,
		"tx_pwr": req.query.TX_PWR,
		"sig_info": addData[0]["R"]
	};

	// is this element already in the buffer? 
	console.log("BUFFER: " + toSource(dupeBuffer));
	if (isInBuffer(dupeBuffer, qso)) {
		console.log("ignoring DUPE");
	} else {
		// insert the new entry in the buffer 
		insertIntoBuffer(dupeBuffer, qso);

		var msgRaw = makeAdifData(qso);
		// There is _NO_ space between Log and <parameters!!! 
		// For this to work, RUMlogNG needs to be configured to accept "QSOs received from Flex radio" - this can 
		// either be set to "Save QSO" or to "Fill fields". In the latter case, the user needs to fill in other potential
		// information and then click on the log button. 
		var msg = "<command:3>Log<parameters:" + msgRaw.length + "> " + msgRaw;

		// console.log("ADIF: " + msg);
        // log the ADIF string to our log file
        /*
        fs.writeFile(logFileName, msg, {'flag' : 'a'}, function(err) {
                if (err) { 
                        return console.error(err);
                }       
        }); 
        */
        // 'a' flag stands for 'append'
        const log = fs.createWriteStream(logFileName, { flags: 'a' });

        // on new log entry ->
        log.write(msg + "\n");

        // you can skip closing the stream if you want it to be opened while
        // a program runs, then file handle will be closed
        log.end();

		// var dgram = require("dgram");
		var socket = dgram.createSocket("udp4");
		socket.bind(function() {
			socket.setBroadcast(true);
		});
		var message = new Buffer.from(msg);
		socket.send(message, 0, message.length, N1MM_Port, N1MM_Addr, function(err, bytes) {
			socket.close();
		});
	}
});

app.get('/log4om/ping', function(req, res) {
        console.log("Log4OM (ping - get) - query: " + toSource(req.query));
        console.log("Log4OM (ping - get) - params: " + toSource(req.params));
//        console.log("Log4OM (ping) - Received: " + toSource(req));
	// res.sendStatus(200);
	res.send("PING tcp, localhost, 8073");
});

app.post('/log4om/ping', function(req, res) {
        console.log("Log4OM (ping - post) - query: " + toSource(req.query));
        console.log("Log4OM (ping - post) - params: " + toSource(req.params));
//        console.log("Log4OM (ping) - Received: " + toSource(req));
	// res.sendStatus(200);
	res.send("PING tcp, localhost, 8073");
});

// We don't need this, but it makes for an simple test to see if the app is running
app.get('/', function(req, res) {
	res.send(`PotaPlus Connector - Listening on port ${port}!`);
});

app.listen(port, function() {
	console.log(`PotaPlus Connector - Listening on port ${port}!`);
});
