"use strict";
import * as ocpp from './ocpp_constants.js'

//
//
// Utility functions
//
//


function generateId() {
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var id = "";
    for (var i = 0; i < 36; i++) {
        id += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return id;
}

function isEmpty(str) {
    return (!str || 0 === str.length);
}

//
// Store a key value in session storage
// @param key The key name
// @param value The key value
//
function setSessionKey(key, value) {
    sessionStorage.setItem(key, value)
}

//
// Get a key value from session storage
// @param key The key name
// @return The key value
//
function getSessionKey(key, default_value = "") {
    var v = sessionStorage.getItem(key);
    if (!v) {
        v = default_value;
    }
    return v
}

//
// Store a key value in local storage
// @param key The key name
// @param value The key value
//
function setKey(key, value) {
    localStorage.setItem(key, value)
}

//
// Get a key value from session storage
// @param key The key name
// @return The key value
//
function getKey(key, default_value = "") {
    var v = localStorage.getItem(key);
    if (!v) {
        v = default_value;
    }
    return v
}

//
//
// OCPPChargePoint class
//
//
export default class ChargePoint {

    //
    // Constructor
    // @param a callback function that will receive debug logging information
    //
    constructor() {
        this._websocket = null;
        this._heartbeat = null;
        this._statusChangeCb = null;
        this._availabilityChangeCb = null;
        this._loggingCb = null;

        // Either "Accepted" or "Rejected"
        this._remoteStartStopResponse = "Accepted";
        this._remoteStartDelaySeconds = 0;
    }

    //
    // Set the StatusChange callback, this will be triggered when the internal status
    // of the charge point change
    // @param A callback function which takes two string arguments ("new status","optionnal detail")
    //
    setStatusChangeCallback(cb) {
        this._statusChangeCb = cb;
    }

    //
    // Set the logging callback, this will be triggered when the charge point want to output/log some information
    // @param A callback function which takes a string argument ("message to log")
    //
    setLoggingCallback(cb) {
        this._loggingCb = cb;
    }

    //
    // Set the logging callback, this will be triggered when the OCPP server triggers a SetAvailability message
    // @param A callback function which takes two arguments (int + string): (connectorId,"new availability")
    //
    setAvailabilityChangeCallback(cb) {
        this._availabilityChangeCb = cb;
    }

    //
    // output a log to the logging callback if any
    //
    logMsg(msg) {
        if (this._loggingCb) {
            msg = '[OCPP] ' + msg;
            this._loggingCb(msg);
        }
    }

    //
    // Set the internal status of the CP and call the status update callbalck if any
    // @param s The new status value
    // @param msg Optional message (for information purpose)
    //
    setStatus(s, msg = "") {
        setSessionKey(ocpp.KEY_CP_STATUS, s);
        if (this._statusChangeCb) {
            this._statusChangeCb(s, msg);
        }
    }

    //
    // Handle a command coming from the OCPP server
    //
    async handleCallRequest(id, request, payload) {
        var respOk = JSON.stringify([3, id, { "status": "Accepted" }]);
        var connectorId = 0;
        switch (request) {
            case "Reset":
                //Reset type can be SOFT, HARD
                var rstType = payload.type;
                this.logMsg("Reset Request: type=" + rstType);
                this.wsSendData(respOk);
                this.wsDisconnect();
                break;

            case "RemoteStartTransaction":
                const tagId = payload.idTag;
                this.logMsg("Reception of a RemoteStartTransaction request for tag " + tagId);

                const rstConf = JSON.stringify([3, id, { "status": this._remoteStartStopResponse}])
                this.wsSendData(rstConf);
                
                if(this._remoteStartStopResponse == "Rejected") {
                    break;
                }

                // Simulate time it takes for user to plug in charger
                this.logMsg(`Simulating ${this._remoteStartDelaySeconds} sec delay for user to plug in charger`);
                await new Promise(resolve => setTimeout(resolve, 1000 * this._remoteStartDelaySeconds))
                
                this.startTransaction(tagId);
                break;

            case "RemoteStopTransaction":
                var stop_id = payload.transactionId;
                this.logMsg("Reception of a RemoteStopTransaction request for transaction " + stop_id);
                const respConf = JSON.stringify([3, id, { "status": this._remoteStartStopResponse}])
                this.wsSendData(respConf);
                if(this._remoteStartStopResponse == "Rejected") {
                    break;
                }
                this.stopTransactionWithId(stop_id);
                break;

            case "TriggerMessage":
                var requestedMessage = payload.requestedMessage;
                // connectorId is optional thus must check if it is provided
                if (payload["connectorId"]) {
                    connectorId = payload["connectorId"];
                }
                this.logMsg("Reception of a TriggerMessage request (" + requestedMessage + ")");
                this.wsSendData(respOk);
                this.triggerMessage(requestedMessage, connectorId);
                break;

            case "ChangeAvailability":
                var avail = payload.type;
                connectorId = payload.connectorId;
                this.logMsg("Reception of a ChangeAvailability request (connector " + connectorId + " " + avail + ")");
                this.wsSendData(respOk);
                this.setConnectorAvailability(Number(connectorId), avail)
                break;

            case "UnlockConnector":
                this.wsSendData(respOk);
                break;

            case "GetConfiguration":
                var requestedMessage = payload.requestedMessage;
                this.logMsg("Reception of a GetConfiguration request (" + requestedMessage + ")");
                const configuration = [
                    3,
                    id,
                    {
                        "unknownKey": [],
                        "configurationKey": [
                            {
                                "key": "HeartbeatInterval",
                                "readonly": false,
                                "value": "900"
                            }
                        ]
                    }
                ];
                this.wsSendData(JSON.stringify(configuration));
                break;

            default:
                var error = JSON.stringify([4, id, "NotImplemented"]);
                this.wsSendData(error);
                break;
        }
    }

    //
    // Handle the response from the OCPP server to a command 
    // @param payload The payload part of the OCPP message
    //
    handleCallResult(payload) {
        const la = this.getLastAction();
        switch(la) {

        case ocpp.BOOT_NOTIFICATION:
            if (payload.status == 'Accepted') {
                this.logMsg("Connection accepted");
                var hb_interval = payload.interval;
                this.setHeartbeat(hb_interval);
                this.setStatus(ocpp.CP_CONNECTED);
            }
            else {
                this.logMsg("Connection refused by server");
                this.wsDisconnect();
            }
            break;
        case ocpp.AUTHORIZE:
            if (payload.idTagInfo.status == 'Invalid') {
                this.logMsg('Authorization failed');
            }
            else {
                this.logMsg('Authorization OK');
                this.setStatus(ocpp.CP_AUTHORIZED);
            }
            break;
        case ocpp.START_TRANSACTION:
            var transactionId = payload.transactionId;
            if (!transactionId) { 
                // doing this so StatusNotifications like "CHARGING" doesnt override transaction id
                break; 
            }
            setSessionKey('TransactionId', transactionId);
            this.setStatus(ocpp.CP_INTRANSACTION, 'TransactionId: ' + transactionId)
            this.logMsg("Transaction id is " + transactionId);
            break;
        case ocpp.STOP_TRANSACTION:
            // assuming id 1 for now.
            const connectorId = 1;
            this.setConnectorStatus(connectorId, ocpp.CONN_AVAILABLE)
            break;
        case ocpp.HEARTBEAT:
            // do nothing
            break;
        case ocpp.METERVALUES:
            // do nothing
            break; 
        case ocpp.STATUSNOTIFICATION:
            // do nothing
            break;
        default:
            this.logMsg("NOT IMPLEMENTED in handleCallResult in ocpp_chargepont.js LastAction: " + la + " payload: " + JSON.stringify(payload));
        }
    }

    //
    // Handle an error response from the OCPP server
    // @param errCode The error code
    // @param errMsg  The clear text description of the error
    //
    handleCallError(errCode, errMsg) {
        this.setStatus(ocpp.CP_ERROR, 'ErrorCode: ' + errCode + ' (' + errMsg + ')');
    }

    //
    // Send an Authorize call to the OCPP Server
    // @param tagId the id of the RFID tag to authorize
    //
    authorize(tagId) {
        this.setLastAction("Authorize");
        this.logMsg("Requesting authorization for tag " + tagId);
        const id = generateId();
        const Auth = JSON.stringify([2, id, "Authorize", {
            "idTag": tagId
        }]);
        this.wsSendData(Auth);
    }

    //
    // Send a StartTransaction call to the OCPP Server
    // @param tagId the id of the RFID tag currently authorized on the CP
    //
    startTransaction(tagId, connectorId = 1, reservationId = 0) {
        this.setStatus(ocpp.CP_INTRANSACTION);
        const mv = this.meterValue();
        const id = generateId();
        const strtTobjekt =[2, id, ocpp.START_TRANSACTION, {
            "connectorId": connectorId,
            "idTag": tagId,
            "meterStart": mv,
            "timestamp": luxon.DateTime.utc().toISO()
        }];
        if (reservationId != 0){
            strtTobjekt[3].reservationId = reservationId;
        }
        const strtT = JSON.stringify(strtTobjekt);
        this.logMsg("Starting Transaction for tag " + tagId + " (connector:" + connectorId + ", meter value=" + mv + ")");
        this.wsSendData(strtT);
        this.setConnectorStatus(connectorId, ocpp.CONN_CHARGING, true);
        this.setLastAction(ocpp.START_TRANSACTION);
    }

    //
    // Send a StopTransaction call to the OCPP Server
    // @param tagId the id of the RFID tag currently authorized on the CP
    //
    stopTransaction(tagId) {
        var transactionId = parseInt(getSessionKey("TransactionId"));
        this.stopTransactionWithId(transactionId, tagId);
    }

    //
    // Send a StopTransaction call to the OCPP Server
    // @param transactionId the id of the transaction to stop
    // @param tagId the id of the RFID tag currently authorized on the CP
    //
    async stopTransactionWithId(transactionId, tagId = "DEADBEEF") {
        this.setLastAction(ocpp.STOP_TRANSACTION);
        this.setStatus(ocpp.CP_AUTHORIZED);
        var mv = this.meterValue();
        this.logMsg("Stopping Transaction with id " + transactionId + " (meterValue=" + mv + ")");
        var id = generateId();
        var stopParams = {
            "transactionId": transactionId,
            "timestamp": luxon.DateTime.utc().toISO(),
            "meterStop": mv
        };
        if (!isEmpty(tagId)) {
            stopParams["idTag"] = tagId;
        }
        var stpT = JSON.stringify([2, id, "StopTransaction", stopParams]);
        this.wsSendData(stpT);
        //wait 1s
        await new Promise(resolve => setTimeout(resolve, 1000))
        this.setConnectorStatus(1, ocpp.CONN_FINISHING, true);

        await new Promise(resolve => setTimeout(resolve, 1000))
        this.setConnectorStatus(1, ocpp.CONN_AVAILABLE, true);
    }

    //
    // Implement the TriggerMessage request
    // @param requestedMessage the message that shall be triggered
    // @param c connectorId concerned by the message (if any)
    //
    triggerMessage(requestedMessage, c = 0) {
        switch (requestedMessage) {
            case 'BootNotification':
                this.sendBootNotification();
                break;
            case 'Heartbeat':
                this.sendHeartbeat();
                break;
            case 'MeterValues':
                this.sendMeterValue(c);
                break;
            case 'StatusNotification':
                this.sendStatusNotification(c);
                break;
            case 'DiagnosticStatusNotification':
                break;
            case 'FirmwareStatusNotification':
                break;
            default:
                this.logMsg("Requested Message not supported: " + requestedMessage);
                break;
        }
    }

    //
    // Send a BootNotification call to the OCPP Server
    //
    sendBootNotification() {
        this.logMsg('Sending BootNotification');
        this.setLastAction(ocpp.BOOT_NOTIFICATION);
        var id = generateId();
        var bn_req = JSON.stringify([2, id, "BootNotification", {
            "chargePointVendor": "ocpp-cp-simulator",
            "chargePointModel": "JAVASCRIPT SIMULATOR",
            "chargePointSerialNumber": "TEST_00000001",
            "chargeBoxSerialNumber": "TEST_00000001",
            "firmwareVersion": "1.0.0",
            "iccid": "",
            "imsi": "",
            "meterType": "",
            "meterSerialNumber": ""
        }]);
        this.wsSendData(bn_req);
    }

    // @todo: Shitty code to remove asap => real transaction support
    setLastAction(action) {
        setSessionKey("LastAction", action);
    }
    // @todo: Shitty code to remove asap
    getLastAction() {
        return getSessionKey("LastAction");
    }

    //
    // Setup heartbeat sending at the appropriate period
    // (clearing any previous setup)
    // @param period The heartbeat period in seconds
    //
    setHeartbeat(period) {
        this.logMsg("Setting heartbeat period to " + period + "s");
        if (this._heartbeat) {
            clearInterval(this._heartbeat);
        }
        this._heartbeat = setInterval(this.sendHeartbeat.bind(this), period * 1000);
    }

    //
    // Send a heartbeat to the OCPP Server
    //
    sendHeartbeat() {
        this.setLastAction("Heartbeat");
        var id = generateId();
        var HB = JSON.stringify([2, id, "Heartbeat", {}]);
        this.logMsg('Heartbeat');
        this.wsSendData(HB);
    }

    //
    // Send data to the server (will be also logged in console)
    // @data the data to send 
    //
    wsSendData(data) {
        console.log("["+ luxon.DateTime.utc().toISO() + "] [ -> ] " + data);
        //if (this._loggingCb) {
        //    this._loggingCb("[ -> ] " + data);
        //}
        if (this._websocket) {
            this._websocket.send(data);
        }
        else {
            this.setStatus(ocpp.CP_ERROR, 'No connection to OCPP server')
        }
    }

    //
    // @return the internal state of the CP
    //
    status() {
        return getSessionKey(ocpp.KEY_CP_STATUS);
    }

    //
    // Open the websocket and set internal state accordingly
    // @param wsurl The URL of the OCPP server
    // @param cpid  The charge point identifief (as defined in OCPP server)
    //
    wsConnect(wsurl, cpid) {
        if (this._websocket) {
            this.setStatus(ocpp.CP_ERROR, 'Socket already opened. Closing it. Retry later');
            this._websocket.close(3001);
        }
        else {

            this._websocket = new WebSocket(wsurl + "" + cpid, ["ocpp1.6", "ocpp1.5"]);
            var self = this

            //
            // OnOpen Callback
            //
            this._websocket.onopen = function (evt) {
                self.setStatus(ocpp.CP_CONNECTING);
                self.sendBootNotification();
            }

            //
            // OnError Callback
            //                  
            this._websocket.onerror = function (evt) {
                switch (self._websocket.readyState) {
                    case 1: // OPEN
                        self.setStatus(ocpp.CP_ERROR, 'ws normal error: ' + evt.type)
                        break;
                    case 3: // CLOSED
                        self.setStatus(ocpp.CP_ERROR, 'connection cannot be opened: ' + evt.type)
                        break;
                    default:
                        self.setStatus(ocpp.CP_ERROR, 'websocket error: ' + evt.type)
                        break;
                }

            }

            //
            // OnMessage Callback
            // Decode the type of message and pass it to the appropriate handler
            // 
            this._websocket.onmessage = function (msg) {
                console.log("["+ luxon.DateTime.utc().toISO() + "] [ <- ] " + msg.data);
                //if (self._loggingCb) {
                //    self._loggingCb("[ <- ] " +  msg.data);
                //}
                var ddata = JSON.parse(msg.data);

                // Decrypt Message Type
                var msgType = ddata[0];
                switch (msgType) {
                    case 2: // CALL 
                        var id = ddata[1];
                        var request = ddata[2];
                        var payload = null;
                        if (ddata.length > 3) {
                            payload = ddata[3];
                        }
                        self.handleCallRequest(id, request, payload);
                        break;
                    case 3: // CALLRESULT 
                        self.handleCallResult(ddata[2]);
                        break;
                    case 4: // CALLERROR
                        self.handleCallError(ddata[2], ddata[3]);
                        break;
                }
            }

            //
            // OnClose Callback
            //   
            this._websocket.onclose = function (evt) {
                if (self._heartbeat) {
                    clearInterval(self._heartbeat);
                    self._heartbeat = null;
                }
                if (evt.code == 3001) {
                    self.setStatus(ocpp.CP_DISCONNECTED);
                    self.logMsg('Connection closed');
                    self._websocket = null;
                } else {
                    self.setStatus(ocpp.CP_ERROR, 'Connection error: ' + evt.code);
                    self.logMsg('Connection error: ' + evt.code);
                    self._websocket = null;
                }
            }
        }
    }

    //
    // Close the websocket and set internal state accordingly
    //
    wsDisconnect() {
        if (this._websocket) {
            this._websocket.close(3001);
        }
        this.setStatus(ocpp.CP_DISCONNECTED);
    }

    //
    // Return the meter value
    //
    meterValue() {
        return (parseInt(getSessionKey(ocpp.KEY_METER_VALUE, "0")));
    }

    //
    // Set the meter value (and optionnally update the OCPP server with it)
    // @param v the new meter value
    // @param updateServer if set to true, update the server with the new meter value
    //
    setMeterValue(v, updateServer = false) {
        setSessionKey(ocpp.KEY_METER_VALUE, v);
        if (updateServer) {
            this.sendMeterValue();
        }
    }

    //
    // update the server with the internal meter value
    //
    sendMeterValue(connectorId = 1) {
        var mvreq = {};
        this.setLastAction("MeterValues");
        var meter = getSessionKey(ocpp.KEY_METER_VALUE);
        var id = generateId();
        var transactionId =  parseInt(getSessionKey('TransactionId'));
        mvreq = JSON.stringify([
            2,
            id,
            "MeterValues",
            {
                "connectorId": connectorId,
                "transactionId": transactionId,
                "meterValue": [{
                    "sampledValue": [
                        {
                            "value": meter,
                            "context": "Sample.Periodic",
                            "measurand": "Energy.Active.Import.Register",
                            "location": "Outlet",
                            "unit": "kWh"
                        }
                    ],
                    "timestamp": luxon.DateTime.utc().toISO(),
                }]
            }
        ]);
        this.logMsg("Send Meter Values: " + meter + " (connector " + connectorId + ")");
        this.wsSendData(mvreq);
    }

    //
    // Get the status of given connector
    // @param c connectorId
    // @return connector status as string
    //
    connectorStatus(c) {
        var key = ocpp.KEY_CONN_STATUS + c;
        return getSessionKey(key);
    }

    //
    // Update status of given connector
    // @param c connectorId
    // @param new status for connector
    // @param updateServer if true, also send a StatusNotification to server
    //
    setConnectorStatus(c, newStatus, updateServer = false) {
        var key = ocpp.KEY_CONN_STATUS + c;
        setSessionKey(key, newStatus);
        if (updateServer) {
            this.sendStatusNotification(c, newStatus);
        }
    }

    //
    // Send a StatusNotification to the server with the new status of the specified connector
    // @param c The connector id (0 for CP, 1 for connector 1, etc...)
    //
    sendStatusNotification(c) {
        var st = this.connectorStatus(c);
        this.setLastAction("StatusNotification");
        var id = generateId();
        var sn_req = JSON.stringify([2, id, "StatusNotification", {
            "connectorId": c,
            "errorCode": "NoError",
            "status": st,
            "timestamp": luxon.DateTime.utc().toISO()
        }]);
        this.logMsg("Sending StatusNotification for connector " + c + ": " + st);
        this.wsSendData(sn_req);
    }
    //[2,"n6xoSNnVilR684LnBNYF4C5D5BgxYkYYknsU","StatusNotification",{"connectorId":0,"status":"Available","errorCode":"NoError","info":"","timestamp":"2023-10-17T08:45:43.774Z","vendorId":"","vendorErrorCode":""}]
    //[2,"B7iniEeNBpD7zW45us3Knxw5dDKxL5RsxTH7","StatusNotification",{"connectorId":0,"status":"Available","errorCode":"NoError","info":"","timestamp":"2023-10-17T08:48:02.075Z","vendorId":"","vendorErrorCode":""}]

    //
    // Get availability for given connector
    // (availability is persistent thus stored in local storage instead of session storage)
    // @param c connector id
    // @return connector availability
    //
    availability(c = 0) {
        var key = ocpp.KEY_CONN_AVAILABILITY + c;
        return getKey(key, ocpp.AVAILABITY_OPERATIVE);
    }

    //
    // Update the availability of given connector
    // (availability is set by remote server thus no "updateServer" flag as for connector status)
    // @param c connectorId
    // @param new availability for connector
    //
    setConnectorAvailability(c, newAvailability) {
        var key = ocpp.KEY_CONN_AVAILABILITY + c;
        setKey(key, newAvailability);
        if (newAvailability == ocpp.AVAILABITY_INOPERATIVE) {
            this.setConnectorStatus(c, ocpp.CONN_UNAVAILABLE, true);
        }
        else if (newAvailability == ocpp.AVAILABITY_INOPERATIVE) {
            this.setConnectorStatus(c, ocpp.CONN_AVAILABLE, true);
        }
        if (this._availabilityChangeCb) {
            this._availabilityChangeCb(c, newAvailability);
        }
        if (Number(c) == 0) {
            this.setConnectorAvailability(1, newAvailability);
            this.setConnectorAvailability(2, newAvailability);
        }
    }
}
