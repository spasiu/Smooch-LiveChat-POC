'use strict';

require('dotenv').config();

const kue = require('kue');
const fetch = require('node-fetch');
const Smooch = require('smooch-core');
const express = require('express');
const bodyParser = require('body-parser');

const PORT = process.env.PORT;
const SMOOCH_ACCOUNT_KEY_ID = process.env.SMOOCH_ACCOUNT_KEY_ID;
const SMOOCH_ACCOUNT_SECRET = process.env.SMOOCH_ACCOUNT_SECRET;
const SMOOCH_APP_ID = process.env.SMOOCH_APP_ID;
const SMOOCH_WEBHOOK_SECRET = process.env.SMOOCH_WEBHOOK_SECRET;
const LIVECHAT_LICENCE_ID = process.env.LIVECHAT_LICENCE_ID;
const LIVECHAT_EMAIL = process.env.LIVECHAT_EMAIL;
const LIVECHAT_KEY = process.env.LIVECHAT_KEY;
const LIVECHAT_BASE_URL = `https://${LIVECHAT_EMAIL}:${LIVECHAT_KEY}@api.livechatinc.com`;
const POLLING_INTERVAL_MS = 2000; // (2 seconds)
const CONVERSATION_TIMEOUT_MS = 300000; // (5 minutes)

const queue = kue.createQueue();
const smooch = new Smooch({
	keyId: SMOOCH_ACCOUNT_KEY_ID,
	secret: SMOOCH_ACCOUNT_SECRET,
	scope: 'account'
});

queue.process('poll', pollLiveChatForMessages);

express()
	.post('/', bodyParser.json(), handleSmoochWebhook)
	.listen(PORT, () => console.log(`listening on port ${PORT}`));


/*
	Receive messages from Smooch as Webhook events
*/

async function handleSmoochWebhook(req, res) {
	if (req.headers['x-api-key'] !== SMOOCH_WEBHOOK_SECRET) {
		console.error('Smooch webhook event failed validation', Date.now());
		return res.status(200).end();
	}

	if (req.body.trigger !== 'message:appUser') {
		console.info('Ignoring non message:appUser webhook trigger', Date.now());
		return res.status(200).end();
	}

	console.info('Handle Smooch webhook for', req.body.appUser._id);

	const name = req.body.appUser.name;
	const visitorId = req.body.appUser._id;
	const lastSessionId = req.body.appUser.properties.lastSessionId;
	const text = req.body.messages.map((message) => message.text).join('\n');

	try {
		const sessionId = await startLiveChat(visitorId, name);
		if (sessionId) {
			await storeSessionIdOnSmoochUser(visitorId, sessionId);
			await queue.create('poll', {
				lastMessageTimestamp: Date.now(),
				sessionId,
				visitorId
			})
				.delay(POLLING_INTERVAL_MS)
				.save();
		}

		await sendMessageToLiveChat(visitorId, sessionId || lastSessionId, text);
		res.status(200).end();
	} catch (error) {
		console.error('Error receiving Smooch webhook', Date.now(), error);
		res.status(200).end(error.message);
	}
}


/*
	Poll for LiveChat messages
*/

async function pollLiveChatForMessages(job, done) {
	const now = Date.now();

	console.info('Process polling job for', job.data.visitorId);

	try {
		if (job.data.lastMessageTimestamp + CONVERSATION_TIMEOUT_MS < now) {
			await closeLiveChat(job.data.visitorId, job.data.sessionId);
			return done();
		}

		const messageData = await getLiveChatMessages(job.data.visitorId, job.data.sessionId, job.data.lastMessageId);
		if (!messageData.text) {
			await queue.create('poll', job.data).delay(POLLING_INTERVAL_MS).save();
			return done();
		}

		await sendMessageToSmooch(job.data.visitorId, messageData.text);
		await queue.create('poll', Object.assign(job.data, {
			lastMessageId: messageData.lastMessageId,
			lastMessageTimestamp: now
		}))
			.delay(POLLING_INTERVAL_MS)
			.save();

		return done();
	} catch (error) {
		console.error('Error polling LiveChat', now, job.data, error);
		done(error);
	}
}


/*
	Endpoints:
	- storeSessionIdOnSmoochUser
	- sendMessageToSmooch
	- startLiveChat
	- closeLiveChat
	- sendMessageToLiveChat
	- getLiveChatMessages
*/

// storeSessionIdOnSmoochUser :: (visitorId, sessionId) -> Promise(undefined)
async function storeSessionIdOnSmoochUser(visitorId, sessionId) {
	await smooch.appUsers.update(SMOOCH_APP_ID, visitorId, {
		properties: { lastSessionId: sessionId }
	});

	console.info('Called storeSessionIdOnSmoochUser for', visitorId);
}

// sendMessageToSmooch :: (visitorId, text) -> Promise(undefined)
async function sendMessageToSmooch(visitorId, text) {
	await smooch.appUsers.sendMessage(SMOOCH_APP_ID, visitorId, {
		text, type: 'text', role: 'appMaker'
	});

	console.info('Called sendMessageToSmooch for', visitorId);
}

// startLiveChat :: (visitorId, name) -> Promise(sessionId)
async function startLiveChat(visitorId, name) {
	const response = await fetch(`${LIVECHAT_BASE_URL}/visitors/${visitorId}/chat/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-VERSION': 2 },
		body: JSON.stringify({
			name,
			visitor_id: visitorId,
			licence_id: LIVECHAT_LICENCE_ID,
			welcome_message: 'chat started' // not displayed to user
		})
	});

	const data = await response.json();

	console.info('Called startLiveChat for', visitorId);

	return data.secured_session_id;
}

// closeLiveChat :: (visitorId, sessionId) -> Promise(undefined)
async function closeLiveChat(visitorId, sessionId) {
	await fetch(`${LIVECHAT_BASE_URL}/visitors/${visitorId}/chat/close`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-VERSION': 2 },
		body: JSON.stringify({
			secured_session_id: sessionId,
			licence_id: LIVECHAT_LICENCE_ID
		})
	});

	console.info('Called closeLiveChat for', visitorId);
}

// sendMessageToLiveChat :: (visitorId, sessionId, text) -> Promise(undefined)
async function sendMessageToLiveChat(visitorId, sessionId, text) {
	await fetch(`${LIVECHAT_BASE_URL}/visitors/${visitorId}/chat/send_message`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-VERSION': 2 },
		body: JSON.stringify({
			secured_session_id: sessionId,
			licence_id: LIVECHAT_LICENCE_ID,
			message: text
		})
	});

	console.info('Called sendMessageToLiveChat for', visitorId);
}

// getLiveChatMessages :: (visitorId, sessionId, messageId) -> Promise({ text, lastMessageId })
async function getLiveChatMessages(visitorId, sessionId, messageId) {
	let url = `${LIVECHAT_BASE_URL}/visitors/${visitorId}/chat/get_pending_messages?licence_id=${LIVECHAT_LICENCE_ID}&secured_session_id=${sessionId}`;
	if (messageId) {
		url += `&last_message_id=${messageId}`;
	}

	const response = await fetch(url, { headers: { 'Content-Type': 'application/json', 'X-API-VERSION': 2 } });
	const data = await response.json();

	const text = data.events
		.filter((event) => event.user_type === 'agent')
		.filter((event) => event.type === 'message')
		.map((event) => event.text)
		.join('\n');

	const lastMessageId = data.events
		.map((event) => event.message_id)
		.reduce((max, id) => id > max ? id : max, messageId);

	console.info('Called getLiveChatMessages for', visitorId);

	return { text, lastMessageId: lastMessageId + 1 };
}
