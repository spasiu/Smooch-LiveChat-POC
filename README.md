# Smooch-LiveChat-POC

## Requirements

- Node.js v8+
- Redis

## To install:

1. run `npm install`
2. configure a _.env_ file using _.env.example_ as a guide
3. set a webhook from your Smooch app to point at this service (from https://app.smooch.io/apps/<app_id>/webhooks)
4. run `node chat`

## Trying out structured messages

Smooch allows you to send [structured messages](https://docs.smooch.io/guide/structured-messages/) like buttons and cards across all messaging channels using the same API call. Normally, you would create UI elements for the agent to send these structured messages via the Smooch REST API. However, you can test a subset of these structured messages using Smooch's [messaging shorthand](https://docs.smooch.io/guide/sending-images-and-buttons-shorthand/) in plaintext messages.
