'use strict'

//**************************************************************************
// This is an example of API modbus driver for OrangeScada
// You can implement any other drives, using this code as template.
// For implement features of your own driver, please create custom module.
// In this example this module is modbusTCPDriver.js
// Full description of all API functions you can get from cite
// https://www.orangescada.ru/docs/
//
// Version 1.1
// Author: OrangeScada company
//
//**************************************************************************


// Include custom driver
const CustomDriver = require('./OpcUADriver.js');

//*****************************************************************
// LOGGER PART
//*****************************************************************


const log = true;

/**
 * logger - Log message to console
 * @param {string} message 
 */
function logger(message){
	if(log) console.log(message);
}


//*****************************************************************
// GET AND SET CONFIG PART
//*****************************************************************

const fs=require('fs'),
path = require('path');

/**
 * getConfig - returns config object from config file
 * @returns {object}
 */
function getConfig(){
	const root = path.dirname(require.main.filename);
	let configJSON = {}
	let configRestore = false
	if (!fs.existsSync(root+'/driverConfig.json')) {
      configJSON = fs.readFileSync(root+'/driverConfig.default', 'utf-8');
	  configRestore = true
	} else {
	  configJSON = fs.readFileSync(root+'/driverConfig.json', 'utf-8');
	}
	let config = null;
	try{
		config = JSON.parse(configJSON);
		if (configRestore) setConfig(config)
	}catch(e){
		logger('Error JSON parse config file: ' + e);
	}
	return config;
}

/**
 * setConfig - write config object to config file
 * @param {object} config - config object
 */
function setConfig(config) {
	const configDeepCopy = JSON.parse(JSON.stringify(config))
	Object.values(configDeepCopy.devices).forEach(device => {
	  if (device?.tags) {
	    Object.values(device.tags).forEach(tag => {
	  	  delete tag.subscribed
	    })
	  }
	})
	let configJSON = JSON.stringify(configDeepCopy, null, 2);
	const root = path.dirname(require.main.filename);
	try{
		fs.writeFileSync(root+'/driverConfig.json', configJSON, {encoding: "utf8"});
	}catch(e){
		logger('Error write config file: ' + e);
	}
}

//*****************************************************************
// Class ObjList for common operations on Nodes and Devices
//*****************************************************************

// Error text constants

const errServerConnectClosedTxt 	= 'Server connect closed';
const errServerConnectTxt 			= 'Server connect error';
const errCmdNotRecognizedTxt 		= 'Command not recognized';
const errIdNotFoundTxt 				= 'ID not found';
const errJSONParseTxt				= 'Error JSON parse:';
const errOptionsNotFoundTxt			= 'Options not found';
const errOptionsValidFailTxt		= 'Option value not valid';
const errNameAbsentTxt		  		= 'Name is absent in request';
const errIdAbsentTxt		  	  	= 'ID is absent in request';
const errWrongTypeTxt				= 'Wrong type';
const errOptionNameAbsentTxt		= 'Option name absent';
const errSelectValuesAbsentTxt		= 'Select values absent';
const errUidListTxt					= 'ID list read fail';
const errItemNotEditable			= 'Item is not editable';

// Buffer accumulator timer for async response

let accumBuffer = {};
let accumTimer = undefined;
const accumTime = 100;

/**
 * Common class for list of nodes, devices or tags
 */
class ObjList {
	/**
	 * constructor of class
	 * @param {object} list - list of nodes, devices or tags
	 * @param {string} itemType - nodes|devices|tags
	 * @param {object} nodes - list of nodes (necessary for devices itemtype)
	 */
	constructor(list, itemType, nodes){
		this.list = list;
		this.itemType = itemType;
		this.nodes = nodes;
	}
	
	/**
	 * getListArray - transfers list object to array
	 * @returns {array} - array of objects [{name: value, uid: value}]
	 */
	getListArray(){
		let res = [];
		for(let item in this.list){
			let itemNode={};
			itemNode.name = this.list[item].name;
			itemNode.uid = item;
			res.push(itemNode);
		};
		return res;
	}

	/**
	 * getNodes - creates answer to getNodes request
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	getNodes(dataObj){
		let answer = {cmd:dataObj.cmd, transID: dataObj.transID, nodes:this.getListArray()};
		return {answer:answer, error:""};
	}

	/**
	 * getDevices - creates answer to getDevices request
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	getDevices(dataObj){
		let devices = [];
		for(let item in this.list){
			if(!dataObj.uid || (this.list[item].nodeUid == dataObj.uid)){
				let deviceItem = {};
				deviceItem.name = this.list[item].name;
				deviceItem.uid = item;
				if(!dataObj.uid) deviceItem.nodeUid = this.list[item].nodeUid;
				devices.push(deviceItem);
			}
		}
		let answer = {cmd:dataObj.cmd, transID: dataObj.transID, devices: devices};
		return {answer:answer, error:""};
	}

	/**
	 * pingItem - creates answer to ping request
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	pingItem(dataObj){
		if(this.list[dataObj.uid]){
			let answer = {};
			if(this.itemType == 'nodes'){
				answer = {cmd:dataObj.cmd, transID: dataObj.transID};
			}else{
				let deviceStatus = customDriver.getDeviceStatus(dataObj);
				if(deviceStatus.error){
					answer = {cmd:dataObj.cmd, transID: dataObj.transID, active: deviceStatus.active, errorTxt: deviceStatus.error};
				}else{
					answer = {cmd:dataObj.cmd, transID: dataObj.transID, active: deviceStatus.active};
				}
			}
			return {answer:answer, error:""};
		}else{
			return {error:errIdNotFoundTxt}
		}
	}

	/**
	 * getOptionsToArray - function transfers config options and item own options to array
	 * @param {string} uid - node unique id
	 * @returns {array}
	 */
	getOptionsToArray(uid){
		let res = [];
		let optionsOwn = this.list[uid].options;
		let optionsScheme = config.optionsScheme && config.optionsScheme[this.itemType] ? config.optionsScheme[this.itemType] : null;
		let items = Object.assign({}, optionsScheme, optionsOwn);
		if(items){
			for(let item in items){
				let itemOption={};
				let optionsSchemeItem = config.optionsScheme && config.optionsScheme[this.itemType] && config.optionsScheme[this.itemType][item] ? config.optionsScheme[this.itemType][item] : null;
				if(optionsSchemeItem){
					itemOption = Object.assign({},optionsSchemeItem,items[item]);
					itemOption.uid = item;
					if(itemOption.type == 'select'){
						itemOption.selectValues = this.getSelectValuesToArray(itemOption.selectValues);
					}
					res.push(itemOption);
				}
			};
		};
		return res;
	}

	/**
	 * getSelectValuesToArray - transfers selectValues object to array
	 * @param {object} selectValues - object {selectID: selectName, ...}
	 * @returns {array}
	 */
	getSelectValuesToArray(selectValues){
		let res = [];
		for(let key in selectValues){
			let item = {};
			item.value = key;
			item.name = selectValues[key];
			res.push(item);
		}
		return res;
	}

	/**
	 * getDefaultOptionsToArray - returns array of item (nodes|devices|tags) scheme options
	 * @returns {array}
	 */
	getDefaultOptionsToArray(){
		let res = [];
		let optionsScheme = config.optionsScheme && config.optionsScheme[this.itemType] ? config.optionsScheme[this.itemType] : null;
		if(optionsScheme){
			for(let item in optionsScheme){
				let itemOption = Object.assign({},optionsScheme[item]);
				itemOption.uid = item;
				if(itemOption.type == 'select'){
					itemOption.selectValues = this.getSelectValuesToArray(itemOption.selectValues);
				}
				res.push(itemOption);
			}
		}
		return res;
	}

	/**
	 * getItem - creates answer to getNode|getDevice|getTag requests
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	getItem(dataObj){
		if(!dataObj.uid){
			let answer = {cmd:dataObj.cmd, transID: dataObj.transID, options: this.getDefaultOptionsToArray()};
			return {answer:answer, error:""};
		}
		let item = this.list[dataObj.uid];
		if(item){
			let answer = {cmd:dataObj.cmd, transID: dataObj.transID, options: this.getOptionsToArray(dataObj.uid)};
			this.appendProps(item, answer);
			return {answer:answer, error:""};
		}else{
			return {error:errIdNotFoundTxt}
		}
	}

	/**
	 * isValueValid - checks if param value is valid
	 * @param {object} optionItem - option item parameters object 
	 * @param {*} value - tested value
	 * @returns {boolean}
	 */
	isValueValid(optionItem, value){
		switch (optionItem.type) {
			case 'varchar':
				return true;
				break;
			case 'bool':
				return (value === false) || (value === true);
				break;
			case 'number':
				if(typeof value !== 'number') return false;
				return (optionItem.minValue === undefined || value >= optionItem.minValue) &&
					   (optionItem.maxValue === undefined || value <= optionItem.maxValue);
				break;
			case 'select':
				return optionItem.selectValues[value];
				break;
			default: return false;
		}
	}

	/**
	 * setItem - sets parameters and creates answer to setNode|setDevice|setTag requests
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	setItem(dataObj){
		if(!isItemsEditable) return {error:errItemNotEditable};
		if(this.list[dataObj.uid]){
			let warning = "";
			let restartOnChange = false;
			if(dataObj.options){
				for(let item of dataObj.options){
					let optionItemKey = Object.keys(item)[0];
					let schemeOptionItem = config.optionsScheme[this.itemType][optionItemKey];
					if(schemeOptionItem.restartOnChange) restartOnChange = true;
					let optionItem = this.list[dataObj.uid].options[optionItemKey];
					if(schemeOptionItem){
						if(!optionItem){
							this.list[dataObj.uid].options[optionItemKey] = {};
							optionItem = this.list[dataObj.uid].options[optionItemKey];
						}
						if(this.isValueValid(schemeOptionItem,item[optionItemKey]) || (item[optionItemKey] === "")){
							optionItem.currentValue = item[optionItemKey];
						}else{
							warning += errOptionsValidFailTxt + ",";
						}
					}else{
						warning += errOptionsNotFoundTxt + ": " + optionItemKey + ",";
					}
				}
			}
			let propsWarning = this.appendProps(dataObj, this.list[dataObj.uid]);
			if(propsWarning) warning += propsWarning + ",";
			let answer = {cmd:dataObj.cmd, transID: dataObj.transID};
			if(warning) logger(this.correctWarningText(warning));
			if(restartOnChange) customDriver.restartDevice(dataObj);
			return {answer:answer, error:"", setConfig: true};
		}else{
			return {error:errIdNotFoundTxt}
		}
	}

	/**
	 * checkType - returns true if type name is valid
	 * @param {string} type - type name
	 * @returns {boolean}
	 */
	checkType(type){
		return ['number','select','bool','varchar'].includes(type);
	}

	/**
	 * getNewNodeId - generates new unique id for nodes|devices|tags list
	 * @returns {int}
	 */
	getNewNodeId(dataObj){
		if(dataObj.uid && !this.list[dataObj.uid]){
			return dataObj.uid
		}else{
			let maxId=0;
			for(let item in this.list){
				let itemInt = parseInt(item);
				if(itemInt && (itemInt > maxId)) maxId = itemInt;
			}
			return maxId + 1;
		}
	}

	/**
	 * addItem - adds new item for nodes|devices|tags, creates answer
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	addItem(dataObj){
		if(!isItemsEditable) return {error:errItemNotEditable};
		if(!dataObj.name) return {error:errNameAbsentTxt};
		let newItem = {};
		let newItemOptions = {};
		newItem.name = dataObj.name;
		if(this.itemType == 'devices'){
			if(dataObj.nodeUid){
				if(this.nodes[dataObj.nodeUid]){
					newItem.nodeUid = dataObj.nodeUid;
				}else{
					return {error:errIdNotFoundTxt};
				}
			}
			newItem.active = true;
		}

		let optionsScheme = config.optionsScheme[this.itemType];
		for(let optionItem in optionsScheme){
			if(!optionsScheme[optionItem].name){
				return {error:errOptionNameAbsentTxt}
			}
			if(!this.checkType(optionsScheme[optionItem].type)){
				return {error:errWrongTypeTxt}
			}
			if((optionsScheme[optionItem].type == 'select') && !optionsScheme[optionItem].selectValues){
				return {error:errSelectValuesAbsentTxt}
			}
			newItemOptions[optionItem] = {};
		}

		newItem.options = newItemOptions;
		let newNodeId = this.getNewNodeId(dataObj);
		this.list[newNodeId] = newItem;
		dataObj.uid = newNodeId;
		let setAnswer = this.setItem(dataObj);
		if(!setAnswer.error){
		  let answer = {cmd:dataObj.cmd, transID: dataObj.transID, uid:newNodeId};
			return {answer:answer, error:"", warning:setAnswer.warning, setConfig: true};
		}else{
			delete this.list[newNodeId];
			return {error:setAnswer.error};
		}
	}

	/**
	 * correctWarningText - kills komma at the end of warning string
	 * @param {string} warning 
	 * @returns {string}
	 */
	correctWarningText(warning){
		if(warning) return warning.slice(0,-1);
		return null;
	}

	/**
	 * deleteItem - removes item in nodes|devices|tags list, creates answer
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	deleteItem(dataObj){
		if(!isItemsEditable) return {error:errItemNotEditable};
		if(dataObj.cmd == 'deleteNode'){
			let deviceUids = [];
			for(let deviceId in deviceList.list){
				if(deviceList.list[deviceId].nodeUid == dataObj.uid) deviceUids.push(deviceId); 
			}
			if(deviceUids) deviceList.deleteItem({'cmd': 'deleteDevice','transID':0, 'uid': deviceUids});
		}
		let deleteUids = dataObj.uid;
		let warning = "";
		if(!deleteUids){
			return {error:errUidListTxt}
		}
		for(let item of deleteUids){
			if(this.list[item]){
				delete this.list[item];
			}else{
				warning += errIdNotFoundTxt + ",";
			}
		}
		let answer = {cmd:dataObj.cmd, transID: dataObj.transID};
		return {answer:answer, error:"", warning:this.correctWarningText(warning), setConfig: true};
	}

	/**
	 * getOptionsValuesToObject - converts options array to object {optionName: currentValue, ...}
	 * @param {array} items - array of options
	 * @returns {object}
	 */
	getOptionsValuesToObject(items){
		let res = {};
		for(let item in items){
			res[item] = items[item].currentValue;
		}
		return res;
	}

	/**
	 * appendProps - check item properties and transfers it to container
	 * @param {object} props 
	 * @param {object} container 
	 * @returns {string} warning text
	 */
	appendProps(props, container){
		let propsWarning = "";
		[{"propName":"name","type":"varchar"},
		 {"propName":"type","type":"select","selectValues":{"bool":"bool","int":"int","float":"float","datetime":"datetime","string":"string"}},
		 {"propName":"address","type":"number"},
		 {"propName":"read","type":"bool"},
		 {"propName":"write","type":"bool"}].map((prop)=>{
			if(props[prop.propName] !== undefined){
				if(this.isValueValid(prop,props[prop.propName])){
					container[prop.propName] = props[prop.propName];
				}else{
					if(!propsWarning) propsWarning = errOptionsValidFailTxt;
				}
			}
		});
		return propsWarning;
	}

	/**
	 * getTags - returns list of tags
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	getTags(dataObj){
		let device = this.list[dataObj.deviceUid];
		if(!device){
			return {error:errIdNotFoundTxt};
		}
		let res = [];
		if(device.tags){
			for(let item in device.tags){
				let tagItem = {};
				tagItem.uid = item;
				let deviceTag = device.tags[item];
				this.appendProps(deviceTag, tagItem);
				if(dataObj.isOptions){
					tagItem.options = this.getOptionsValuesToObject(deviceTag.options);
				}
				res.push(tagItem);
			}
		}
		let answer = {cmd:dataObj.cmd, transID: dataObj.transID, tags:res};
		return {answer:answer, error:""};
	}

	/**
	 * setTagsSubscribe - method sets/unsets subscribed flag, returns answer
	 * @param {object} dataObj - request object
	 * @returns {object}
	 */
	setTagsSubscribe(dataObj){
		for (let item in this.list){
			this.list[item].subscribed = dataObj.tags.includes(item);
		}
		let answer = {cmd:dataObj.cmd, transID: dataObj.transID};
		return {answer:answer, error:""};
	}

}


//*****************************************************************
// Init options for driver
//*****************************************************************


logger('Get init options');
let config = getConfig();
let nodeList = new ObjList(config.nodes, 'nodes');
let deviceList = new ObjList(config.devices, 'devices', config.nodes);
if(!config) process.exit(1);
const {orangeScadaPort, orangeScadaHost, ssl, uid, password, version, isItemsEditable} = config.driver;
let customDriver = new CustomDriver(deviceList, subscribeHandler, logger);


//*****************************************************************
// SERVER PART
//*****************************************************************


// Message text constants

const tryConnectTxt						= 'Try connect to server';
const serverConnectedTxt 				= 'Server connected';
const processExitTxt					= 'Process exit';
const answerTxt							= 'Answer';
const serverRequestTxt					= 'Server request:';
const commandRequestTxt					= 'command request';


// Connect and reconnect to OrangeScada server

const net = require('net');
const tls = require('tls');
const process = require('process');
let server={};
server.connected = false;
server.connecting = false;
server.dataEventFlag = false;
server.currentTransID = 0;

const serverReconnectTimeout = 5000;
setInterval(tryConnectServer, serverReconnectTimeout);
tryConnectServer();

const serverNodataReconnectTimeout = 40000;
setInterval(serverNodataReconnect, serverNodataReconnectTimeout);

const maxTransID = 65535;

/**
 * tryConnectServer - connect trying function, data|close|error events handlers
 */
function tryConnectServer(){
  if(!server.connected && !server.connecting){
    logger(tryConnectTxt);
    server.connecting = true;
    if(ssl){
      let options={
        host: orangeScadaHost,
        port: orangeScadaPort,
        rejectUnauthorized: false,
      };
      server.socket = tls.connect(options, () =>{
		server.connecting = false;
		server.connected = true;
        logger(serverConnectedTxt);
        handShake();
      });
    }else{
      server.socket = new net.Socket();
      server.socket.connect(orangeScadaPort, orangeScadaHost, () => {
		server.connecting = false;
		server.connected = true;
        logger(serverConnectedTxt);
        handShake();
      });
    }
    server.socket.on('data', (data) => {
		parseRequest(data);
		server.dataEventFlag = true;
    });
    server.socket.on('close',(code, reason) => {
      logger(errServerConnectClosedTxt);
      server.connected=false;
	  server.connecting = false;
      server.socket.destroy();
    });
    server.socket.on('error',(e) => {
      logger(errServerConnectTxt+' '+e);
      server.connected=false;
	  server.connecting = false;
      server.socket.destroy();
    });
  };
}

/**
 * serverNodataReconnect - disconnect alarm function, run if no requests in serverNodataReconnectTimeout 
 */
function serverNodataReconnect(){
	if (server.connected && !server.dataEventFlag){
		server.connected=false;
		server.connecting=false;
		server.socket.destroy();		
	}
	server.dataEventFlag = false;
}

/**
 * sendToSocket - function for sending data to socket
 * @param {object} data - sending data object 
 * @param {error} warning - warning text 
 */
function sendToSocket(data, warning){
	if(!server.connected) return;
	if(warning) data.errorTxt = warning;
	let dataStr = JSON.stringify(data);
	logger(answerTxt + ' ' + dataStr);
	server.socket.write(dataStr+'\n\r');
}

// Exit on user halt application 

process.stdin.resume();

process.on('SIGINT', () => {
  logger(processExitTxt);
	server.connected=false;
	server.socket.destroy();
  process.exit();
});


// API requests

/**
 * handShake - sending handshake data on connect to Orangescada server
 */
function handShake(){
	let req;
	if(password){
		req = {cmd: 'connect', uid: uid, password: password, version: version, transID: 0};
	}else{
		req = {cmd: 'connect', uid: uid, version: version, transID: 0};
	}
	sendToSocket(req);
};

// Parse server requests, execute handlers

/**
 * parseRequest - 
 * @param {object} data - parsing requests, get and execute handler
 */
let requestBuffer = ''
function parseRequest(data){
	if (!data.toString().endsWith('\n')) {
		requestBuffer += data.toString()
		return
	}
	let dataStr = requestBuffer.concat(data.toString()).split('\n');
	requestBuffer = '';
	for(let item of dataStr){
		if(!item) continue;
		logger(serverRequestTxt+' '+item);
		let dataObj = null;
		try{
			dataObj = JSON.parse(item);
		}catch(e){
			logger(errJSONParseTxt+' '+e);
			return;
		}
		if(!dataObj) return;
	  let handler = getHandler(dataObj.cmd);
		if(handler){
			handler(dataObj);
			setCurrentTransID(dataObj);
		}else{
			errHandler(errCmdNotRecognizedTxt);
		}
	}
}

// Maping handler for request

/**
 * getHandler - returns handler depend on request type
 * @param {string} cmd - request name
 * @returns {handler}
 */
function getHandler(cmd){
	switch (cmd) {
		case 'connect'		    			: return connectServer;
		case 'pingDriver'		    		: return pingDriver;
		case 'getNodes' 		    		: return getNodes;
		case 'pingNode'  		    		: return pingNode;
		case 'getNode'   					: return getNode;
		case 'setNode'   					: return setNode;
		case 'addNode'   					: return addNode;
		case 'deleteNode'   				: return deleteNode;
		case 'getDevices'       			: return getDevices;
		case 'pingDevice'       			: return pingDevice;
		case 'getDevice' 					: return getDevice;
		case 'setDevice' 					: return setDevice;
		case 'addDevice' 					: return addDevice;
		case 'deleteDevice' 				: return deleteDevice;
		case 'getTags' 			    		: return getTags;
		case 'getTag' 			    		: return getTag;
		case 'setTag' 			    		: return setTag;
		case 'addTag' 			    		: return addTag;
		case 'deleteTag' 			    	: return deleteTag;
		case 'getTagsValues' 	  			: return getTagsValues;
		case 'setTagsValues' 	  			: return setTagsValues;
		case 'setTagsSubscribe'				: return setTagsSubscribe;
		case 'asyncTagsValues'				: return asyncTagsValues;
		default: return null;
	}
}

/**
 * errHandler - sends error data to socket
 * @param {string} errorTxt - error text message
 * @param {object} dataObj - request object
 */
function errHandler(errorTxt, dataObj){
	logger('error answer');
	let answer = {};
	if(dataObj && dataObj.cmd) answer.cmd = dataObj.cmd;
	if(dataObj && dataObj.transID) answer.transID = dataObj.transID;
	answer.errorTxt = errorTxt;
	sendToSocket(answer);
}

/**
 * connectServer - connectServer handler
 */
function connectServer() {
	logger('Connect '+commandRequestTxt);
}

/**
 * socketCommunicate - common method answering to requests
 * @param {object} res - answering result object
 * @param {object} dataObj - request object
 */
function socketCommunicate(res, dataObj) {
	if(res.error == ""){
		sendToSocket(res.answer, res.warning);
		if(res.setConfig) setConfig(config);
	}else{
		errHandler(res.error, dataObj);
	}
}

/**
 * commonHandler - common function for requests handling and call socketCommunicate for answering
 * @param {object} dataObj - request object
 * @param {handler} method - handler for answering
 */
function commonHandler(dataObj, method){
	logger(dataObj.cmd + ' ' + commandRequestTxt);
	let res = {};
	if(!method){
		res.answer = {cmd:dataObj.cmd, transID: dataObj.transID};
		res.error = "";
  	}else{
		res = method(dataObj);
	}
  	socketCommunicate(res, dataObj);
}

/**
 * pingDriver command handler
 * @param {object} dataObj - request object
 */
function pingDriver(dataObj){
	commonHandler(dataObj);
}


//**********************************************************************************************
// You can pass getNodes|pingNode|getNode|setNode|addNode|deleteNode handlers implementation
// if you have not group your devices into nodes. This is not necessary handlers.
//**********************************************************************************************


/**
 * getNodes command handler
 * @param {object} dataObj - request object
 */
function getNodes(dataObj){
	commonHandler(dataObj, nodeList.getNodes.bind(nodeList));
}

/**
 * pingNode command handler
 * @param {object} dataObj - request object
 */
function pingNode(dataObj){
	commonHandler(dataObj, nodeList.pingItem.bind(nodeList));
}

/**
 * getNode command handler
 * @param {object} dataObj - request object
 */
function getNode(dataObj){
	commonHandler(dataObj, nodeList.getItem.bind(nodeList));
}

/**
 * setNode command handler
 * @param {object} dataObj - request object
 */
function setNode(dataObj){
	commonHandler(dataObj, nodeList.setItem.bind(nodeList));
}

/**
 * addNode command handler
 * @param {object} dataObj - request object
 */
function addNode(dataObj){
	commonHandler(dataObj, nodeList.addItem.bind(nodeList));
}

/**
 * deleteNode command handler
 * @param {object} dataObj - request object
 */
function deleteNode(dataObj){
	commonHandler(dataObj, nodeList.deleteItem.bind(nodeList));
}

/**
 * getDevices command handler
 * @param {object} dataObj - request object
 */
function getDevices(dataObj){
	commonHandler(dataObj, deviceList.getDevices.bind(deviceList));
}

/**
 * pingDevice command handler
 * @param {object} dataObj - request object
 */
function pingDevice(dataObj){
	commonHandler(dataObj, deviceList.pingItem.bind(deviceList));
}

/**
 * getDevice command handler
 * @param {object} dataObj - request object
 */
function getDevice(dataObj){
	commonHandler(dataObj, deviceList.getItem.bind(deviceList));
}

/**
 * setDevice command handler
 * @param {object} dataObj - request object
 */
function setDevice(dataObj){
	commonHandler(dataObj, deviceList.setItem.bind(deviceList));
}

/**
 * addDevice command handler
 * @param {object} dataObj - request object
 */
function addDevice(dataObj){
	commonHandler(dataObj, deviceList.addItem.bind(deviceList));
}

/**
 * deleteDevice command handler
 * @param {object} dataObj - request object
 */
function deleteDevice(dataObj){
	commonHandler(dataObj, deviceList.deleteItem.bind(deviceList));
}

function setConfigHandler () {
	setConfig(config);
}

function progressMessage(dataObj) {
	return { 
		error:"", 
		answer: {
			cmd:dataObj.cmd, transID: dataObj.transID, progressTxt: dataObj.progressTxt
		}
	}
}

/**
 * getTags command handler
 * @param {object} dataObj - request object
 */
function getTags(dataObj){
	customDriver.updateTagListFromDevice(dataObj, setConfigHandler)
	.then(res => {
		if (res?.progressTxt) {
			dataObj.progressTxt = res.progressTxt
			commonHandler(dataObj, progressMessage);
		} else {
		    commonHandler(dataObj, deviceList.getTags.bind(deviceList));
		}
	})
	.catch(err => {
		errHandler(err.message, dataObj);
	})
}

/**
 * commonTagHandler - common handler for tag requests
 * @param {object} dataObj - request object
 * @param {string} method - method name
 * @returns 
 */
function commonTagHandler(dataObj, method){
	if((method == 'getItem') && (!dataObj.deviceUid || !dataObj.uid)){
		let tagList = new ObjList({}, 'tags');
		commonHandler(dataObj, tagList[method].bind(tagList));
		return;
	}

	if(dataObj.deviceUid){
		if(config.devices[dataObj.deviceUid]){
			if(!config.devices[dataObj.deviceUid].tags){
				config.devices[dataObj.deviceUid].tags = {};
			};
			let tagList = new ObjList(config.devices[dataObj.deviceUid].tags, 'tags');
			commonHandler(dataObj, tagList[method].bind(tagList));
		}else{
			errHandler(errIdNotFoundTxt, dataObj);
		}
	}else{
		errHandler(errIdAbsentTxt, dataObj);
	}
}

/**
 * getTag command handler
 * @param {object} dataObj - request object
 */
function getTag(dataObj){
	commonTagHandler(dataObj,'getItem');
}

/**
 * setTag command handler
 * @param {object} dataObj - request object
 */
function setTag(dataObj){
	commonTagHandler(dataObj,'setItem');
}

/**
 * addTag command handler
 * @param {object} dataObj - request object
 */
function addTag(dataObj){
	commonTagHandler(dataObj,'addItem');
}

/**
 * deleteTag command handler 
 * @param {object} dataObj - request object
 */
function deleteTag(dataObj){
	commonTagHandler(dataObj,'deleteItem');
}

/**
 * getTagsValues command handler
 * @param {object} dataObj - request object
 */
function getTagsValues(dataObj){
	customDriver.getTagsValues(dataObj)
	.then(res => socketCommunicate(res), res => socketCommunicate(res, dataObj));
}

/**
 * setTagsSubscribe command handler 
 * @param {object} dataObj - request object
 */
function setTagsSubscribe(dataObj){
	commonTagHandler(dataObj,'setTagsSubscribe');
	customDriver.updateSubscribe();
}

// handler invoke from customDriver on data change
/**
 * @param {object} dataObj - request object
 */
function subscribeHandler(dataObj){
	const values = Object.entries(dataObj.values);
	if (values.length === 1){
		const tagname = values[0][0]
		const value = values[0][1]
    	if (!accumBuffer[dataObj.deviceUid]) {
    		accumBuffer[dataObj.deviceUid] = {}
    	}
    	
    	accumBuffer[dataObj.deviceUid][tagname] = value
        if (!accumTimer) {
    		accumTimer = setTimeout(() => {
    	        dataObj.cmd = 'asyncTagsValues';
    	        dataObj.transID = getSubscribTransID();
				Object.entries(accumBuffer).forEach(([dev, values]) => {
					dataObj.deviceUid = dev;
					dataObj.values = values;
    	            sendToSocket(dataObj);
				});
    			accumTimer = undefined;
				accumBuffer = {}
    		}, accumTime)
    	}
    }
}

/**
 * getSubscribTransID - generate id packet for subsribed value change events
 * @returns {int}
 */
function getSubscribTransID(){
	let res = server.currentTransID;
	while(Math.abs(res - server.currentTransID) < 10) res = parseInt(maxTransID * Math.random());
	return res;
}

/**
 * setCurrentTransID - saves current transID
 * @param {object} dataObj - request object
 */
function setCurrentTransID(dataObj){
	server.currentTransID = dataObj.transID;
}


/**
 * asyncTagsValues - confirms server async data recive
 * @param {object} dataObj - request object
 */
function asyncTagsValues(dataObj){
	logger(dataObj.cmd + ' ' + commandRequestTxt);
}

/**
 * setTagsValues command handler
 * @param {object} dataObj - request object
 */
function setTagsValues(dataObj){
	customDriver.setTagsValues(dataObj)
	.then(res => socketCommunicate(res), res => socketCommunicate(res, dataObj));
}