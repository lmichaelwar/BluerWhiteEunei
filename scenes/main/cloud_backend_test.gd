extends Node
## Boundary tests: malformed service responses cannot strand the cast or masquerade as live AI.

var failures := 0
var passed := 0
var callbacks := 0


func _ready() -> void:
	TimeManager.is_paused = true
	var cloud := LLMBackendCloud.new()
	add_child(cloud)
	cloud.configure({"url": "http://127.0.0.1:1"})
	_check("offline calls complete immediately", not cloud.is_available)
	cloud.request_chat([], {}, _receive)
	_check("offline callback returned", callbacks == 1)
	_check("valid JSON envelope parsed", LLMBackendCloud.decode_response({"message": {"content": "{\"line\":\"Hello\"}"}}).get("line") == "Hello")
	_check("array envelope rejected", LLMBackendCloud.decode_response([]).is_empty())
	_check("non-object message rejected", LLMBackendCloud.decode_response({"message": []}).is_empty())
	_check("array model output rejected", LLMBackendCloud.decode_response({"message": {"content": "[]"}}).is_empty())
	cloud._on_health_completed(HTTPRequest.RESULT_SUCCESS, 200, PackedStringArray(), "{}".to_utf8_buffer())
	_check("unrelated HTTP 200 is not live AI", not cloud.is_available)
	cloud._on_health_completed(HTTPRequest.RESULT_SUCCESS, 200, PackedStringArray(), "{\"available\":true,\"model\":\"gpt-6-luna\"}".to_utf8_buffer())
	_check("explicit available health accepted", cloud.is_available)
	cloud._current = {"callback": _receive}
	for i in range(20):
		cloud.request_chat([], {}, _receive, i % 3)
	_check("request backlog bounded", cloud._queue.size() == LLMBackendCloud.MAX_QUEUE)
	_check("high priority goes first", int(cloud._queue[0]["priority"]) == 2)
	cloud._on_completed(HTTPRequest.RESULT_SUCCESS, 429, PackedStringArray(), "{\"error\":\"quota\",\"retry_after\":120}".to_utf8_buffer())
	_check("quota exhaust releases entire backlog", cloud.get_queue_size() == 0 and callbacks == 22)
	_check("quota is visibly marked demo", not cloud.is_available and "quota" in cloud.get_status_text())
	_check("quota retry backs off", cloud._retry_at_ms > Time.get_ticks_msec() + 110000)
	_check("auth is separately labeled", "sign in" in cloud._failure_status(401, {}))
	_check("office budget is not described as OpenAI quota", "office hourly limit" in cloud._failure_status(200, {"code": "local_hour_budget", "status": "local_limit"}))
	_check("hourly retry deadline is honored", cloud._retry_seconds({"retry_after": 1729}) == 1729)
	cloud._set_available(true)
	cloud._next_request_at_ms = Time.get_ticks_msec() + 60000
	cloud.request_chat([], {}, _receive, 2)
	_check("scene waits locally without an HTTP request", cloud._current.is_empty() and cloud._queue.size() == 1 and not cloud._pace_timer.is_stopped())
	cloud.drain_queue()
	_check("switching backend cancels the paced queue", cloud._queue.is_empty() and cloud._pace_timer.is_stopped())
	cloud.queue_free()
	print("%d passed, %d failed" % [passed, failures])
	get_tree().quit(0 if failures == 0 else 1)


func _receive(_success: bool, _data: Dictionary, _error: String) -> void:
	callbacks += 1


func _check(label: String, passed: bool) -> void:
	print("%s %s" % ["PASS" if passed else "FAIL", label])
	if not passed:
		failures += 1
	else:
		self.passed += 1
