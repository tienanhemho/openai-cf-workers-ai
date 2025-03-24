export const chatHandler = async (request, env) => {
	let model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
	let messages = [];
	let error = null;

	// get the current time in epoch seconds
	const created = Math.floor(Date.now() / 1000);
	const uuid = crypto.randomUUID();
	let argumentString = '';
	try {
		// If the POST data is JSON then attach it to our response.
		if (request.headers.get('Content-Type') === 'application/json') {
			let json = await request.json();
			// when there is more than one model available, enable the user to select one
			if (json?.model) {
				const mapper = env.MODEL_MAPPER ?? {};
				model = mapper[json.model] ? mapper[json.model] : json.model;
			}
			if (json?.messages) {
				if (Array.isArray(json.messages)) {
					if (json.messages.length === 0) {
						return Response.json({ error: 'no messages provided' }, { status: 400 });
					}
					messages = json.messages;
				}
			}
			if (!json?.stream) json.stream = false;

			let buffer = '';
			let isLastChunk = false;
			let isToolCall = false;
			const isValidJSON = (str) => {
				try {
					JSON.parse(str);
					return true;
				} catch (e) {
					return false;
				}
			}
			const decoder = new TextDecoder();
			const encoder = new TextEncoder();
			const transformer = new TransformStream({
				transform(chunk, controller) {
					buffer += decoder.decode(chunk);
					// Process buffered data and try to find the complete message
					while (true) {
						const newlineIndex = buffer.indexOf('\n');
						if (newlineIndex === -1) {
							// If no line breaks are found, it means there is no complete message, wait for the next chunk
							break;
						}

						// Extract a complete message line
						const line = buffer.slice(0, newlineIndex + 1);
						// console.log(line);
						// console.log("-----------------------------------");
						buffer = buffer.slice(newlineIndex + 1); // Update buffer

						// Process this line
						try {
							if (line.startsWith('data: ')) {
								const content = line.slice('data: '.length);
								// console.log(content);
								const doneflag = content.trim() == '[DONE]';
								if (doneflag) {
									controller.enqueue(encoder.encode("data: [DONE]\n\n"));
									return;
								}

								const data = JSON.parse(content);
								// console.log(content);
								argumentString += data.response;
								let delta = {
								};
								if (data.usage) {
									if (isValidJSON(argumentString)) {
										isToolCall = true;
										let toolCalls = JSON.parse(argumentString);
										delta.tool_calls = [];
										if (!Array.isArray(toolCalls)) {
											delta.tool_calls.push({
												index: 0,
												id: "call_" + crypto.randomUUID(),
												function: {
													name: toolCalls.name,
													arguments: JSON.stringify(toolCalls.parameters),
												},
												type: 'function',
											});
										}
										else {
											toolCalls.forEach((call, index) => {
												delta.tool_calls.push({
													index: index,
													id: "call_" + crypto.randomUUID(),
													function: {
														name: call.name,
														arguments: JSON.stringify(call.parameters),
													},
													type: 'function',
												});
											});
										}
										console.log(delta);
									}
									else {
										delta.content = argumentString;
										console.log(delta);
									}
								}
								const newChunk =
									'data: ' +
									JSON.stringify({
										id: uuid,
										created,
										object: 'chat.completion.chunk',
										model,
										choices: [
											{
												delta: delta,
												index: 0,
												logprobs: null,
												finish_reason: isLastChunk && isToolCall ? 'tool_calls' : null,
											},
										],
									}) +
									'\n\n';

								isLastChunk = true;
								controller.enqueue(encoder.encode(newChunk));
							}
						} catch (err) {
							console.error('Error parsing line:', err);
						}
					}
				},
			});


			let options = {};
			if (env.GATEWAY_ID !== '') {
				options.gateway = {
					id: env.GATEWAY_ID,
					skipCache: env.GATEWAY_SKIP_CACHE,
				}
			}
			let body = {
				stream: json.stream,
				messages
			};
			if (json?.temperature) body.temperature = json.temperature;
			if (json?.top_p) body.top_p = json.top_p;
			if (json?.n) body.n = json.n;
			if (json?.stop) body.stop = json.stop;
			if (json?.max_tokens) body.max_tokens = json.max_tokens;
			if (json?.presence_penalty) body.presence_penalty = json.presence_penalty;
			if (json?.frequency_penalty) body.frequency_penalty = json.frequency_penalty;
			if (json?.tools) body.tools = json.tools;
			// console.log(body);

			// for now, nothing else does anything. Load the ai model.
			const aiResp = await env.AI.run(model, body, options);
			// Piping the readableStream through the transformStream
			if (json.stream) {
				return new Response(aiResp.pipeThrough(transformer), {
					headers: {
						'content-type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'Connection': 'keep-alive',
					},
				});
			}
			let message = {
				role: 'assistant',
			};
			if (aiResp.response) {
				message.content = aiResp.response;
			}
			if (aiResp.tool_calls) {
				message.tool_calls = aiResp.tool_calls;
			}
			// console.log(aiResp);
			return Response.json({
				id: uuid,
				model,
				created,
				object: 'chat.completion',
				choices: [
					{
						index: 0,
						message: message,
						finish_reason: 'stop',
					},
				],
				usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				},
			});
		}
	} catch (e) {
		error = e;
	}

	// if there is no header or it's not json, return an error
	if (error) {
		return Response.json({ error: error.message }, { status: 400 });
	}

	// if we get here, return a 400 error
	return Response.json({ error: 'invalid request' }, { status: 400 });
};
