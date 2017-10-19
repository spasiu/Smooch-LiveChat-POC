'use strict';

require('dotenv').config();

const curl = require('curlrequest');
const Smooch = require('smooch-core');
const superagent = require('superagent');
const express = require('express');
const bodyParser = require('body-parser');

const PORT = process.env.PORT;
const LIVECHAT_EMAIL = process.env.LIVECHAT_EMAIL;
const LIVECHAT_KEY = process.env.LIVECHAT_KEY;
const LIVECHAT_ENDPOINT = `https://${LIVECHAT_EMAIL}:${LIVECHAT_KEY}@api.livechatinc.com`;
const LIVECHAT_LICENCE_ID = process.env.LIVECHAT_LICENCE_ID;
const SMOOCH_ACCOUNT_KEY_ID = process.env.SMOOCH_ACCOUNT_KEY_ID;
const SMOOCH_ACCOUNT_SECRET = process.env.SMOOCH_ACCOUNT_SECRET;
const SMOOCH_APP_ID = process.env.SMOOCH_APP_ID;

const smooch = new Smooch({
	keyId: SMOOCH_ACCOUNT_KEY_ID,
	secret: SMOOCH_ACCOUNT_SECRET,
	scope: 'account'
});

const sessions = { };

express()
	.use(bodyParser.json())
	.post('/', function(req, res) {
		startLiveChat(req.body.appUser._id, req.body.appUser.name, req.body.appUser.email, function(data) {
			console.log('Starting LiveChat', data)
			if (data.secured_session_id) {
				sessions[req.body.appUser._id] = data.secured_session_id;
				pollLiveChat(req.body.appUser._id, data.secured_session_id);
			}

			const text = req.body.messages.map(message => message.text).join(' ');

			sendMessageToLiveChat(req.body.appUser._id, text, function(messageData) {
				console.log('MESSAGE SENT', data);
			});
		});
		res.end();
	})
	.listen(8000, function() {
		console.log(`listening on port ${PORT}`);
	});

function startLiveChat(visitorId, name, email, cb) {
	const url = `${LIVECHAT_ENDPOINT}/visitors/${visitorId}/chat/start`;
	const data = {
		visitor_id: visitorId,
		licence_id: LIVECHAT_LICENCE_ID,
		welcome_message: 'chat started'
	};

	superagent.post(url).set('X-API-VERSION', 2).send(data).end(function(error, response) {
		if (error) {
			console.log('Error starting LiveChat', url, data, error);
			return;
		}

		cb(response.body);
	});
}

function sendMessageToLiveChat(visitorId, text, cb) {
	const sessionId = sessions[visitorId];
	const url = `${LIVECHAT_ENDPOINT}/visitors/${visitorId}/chat/send_message`;
	const data = {
		secured_session_id: sessionId,
		licence_id: LIVECHAT_LICENCE_ID,
		visitor_id: visitorId,
		message: text
	};

	superagent.post(url).set('X-API-VERSION', 2).send(data).end(function(error, response) {
		if (error) {
			console.log('Error sending message to LiveChat', url, data, error);
			return;
		}

		cb(response.body);
	});
}

function pollLiveChat(visitorId, sessionId, messageId, iteration=0) {
	console.log('POLL', visitorId, iteration);
	if (iteration > 30) {
		return;
	}

	let url = `${LIVECHAT_ENDPOINT}/visitors/${visitorId}/chat/get_pending_messages?licence_id=${LIVECHAT_LICENCE_ID}&secured_session_id=${sessionId}`;
	if (messageId) {
		url += `&last_message_id=${messageId}`;
	}

	superagent.get(url).set('X-API-VERSION', 2).end(function(error, response) {
		if (error) {
			console.log('Error polling LiveChat', url, error);
		} else {	
			const text = response.body.events
				.filter((event) => event.user_type === 'agent')
				.filter((event) => event.type === 'message')
				.map((event) => event.text)
				.join(' ');


			if (text) {
				smooch.appUsers.sendMessage(SMOOCH_APP_ID, visitorId, { text, role: 'appMaker', type: 'text' })
					.then(() => {
						const lastEvent = response.body.events.pop();

						if (lastEvent) {
							messageId = lastEvent.message_id;
						}
						iteration = 0;
					})
					.catch(error => {
						console.log('Error sending message to Smooch', visitorId, error);
					});
			}
		}

		setTimeout(() => pollLiveChat(visitorId, sessionId, messageId, iteration + 1), 2000)
	});
}
