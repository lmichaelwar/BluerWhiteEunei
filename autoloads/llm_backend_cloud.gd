class_name LLMBackendCloud
extends Node
## Private same-origin bridge. Credentials stay on the server, never in the game.

signal status_changed(available: bool)

const MAX_QUEUE := 12
const REQUEST_TIMEOUT := 45.0
const MAX_QUEUE_AGE_MS := 45000

var is_available: bool = false
var model: String = "gpt-6-luna"
var _base_url: String = ""
var _status: String = "Demo · connecting to Luna"
var _retry_at_ms: int = 0
var _queue: Array[Dictionary] = []
var _http: HTTPRequest
var _health_http: HTTPRequest
var _current: Dictionary = {}


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = REQUEST_TIMEOUT
	add_child(_http)
	_http.request_completed.connect(_on_completed)
	_health_http = HTTPRequest.new()
	_health_http.timeout = 8.0
	add_child(_health_http)
	_health_http.request_completed.connect(_on_health_completed)


func configure(config: Dictionary) -> void:
	var next_url: String = str(config.get("url", "")).strip_edges().trim_suffix("/")
	if next_url == "" and OS.has_feature("web"):
		next_url = str(JavaScriptBridge.eval("window.location.origin", true))
	if next_url == "":
		next_url = "http://127.0.0.1:8787"
	var next_model: String = str(config.get("model", "gpt-6-luna"))
	if next_url != _base_url or next_model != model:
		drain_queue()
		_base_url = next_url
		model = next_model
		_retry_at_ms = 0
		_set_available(false)


func check_health() -> void:
	if Time.get_ticks_msec() < _retry_at_ms:
		return
	if _health_http.get_http_client_status() != HTTPClient.STATUS_DISCONNECTED:
		return
	var err := _health_http.request(_base_url + "/api/health")
	if err != OK:
		_pause("Demo · cloud unavailable", 30)


func request_chat(messages: Array, format: Dictionary, callback: Callable, priority: int = 0, options: Dictionary = {}) -> void:
	if not is_available:
		callback.call(false, {}, _status)
		return
	if _queue.size() >= MAX_QUEUE:
		callback.call(false, {}, "Cloud queue full; using demo behavior")
		return
	var entry := {"messages": messages, "format": format, "callback": callback,
		"priority": priority, "options": options, "created_ms": Time.get_ticks_msec()}
	var insert_at := _queue.size()
	for i in range(_queue.size()):
		if priority > int(_queue[i]["priority"]):
			insert_at = i
			break
	_queue.insert(insert_at, entry)
	_process_next()


func get_queue_size() -> int:
	return _queue.size() + (0 if _current.is_empty() else 1)


func get_status_text() -> String:
	return _status


func _process_next() -> void:
	if not is_available or not _current.is_empty():
		return
	while not _queue.is_empty():
		var entry: Dictionary = _queue.pop_front()
		if Time.get_ticks_msec() - int(entry["created_ms"]) > MAX_QUEUE_AGE_MS:
			entry["callback"].call(false, {}, "Cloud request expired")
			continue
		_current = entry
		var body := {"model": model, "messages": entry["messages"], "stream": false,
			"format": entry["format"], "options": entry["options"]}
		var err := _http.request(_base_url + "/api/chat", ["Content-Type: application/json"],
			HTTPClient.METHOD_POST, JSON.stringify(body))
		if err != OK:
			_fail_current("Cloud request could not start")
			_pause("Demo · cloud unavailable", 30)
		return


func _on_health_completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	var data: Variant = _parse_json(body.get_string_from_utf8())
	if result == HTTPRequest.RESULT_SUCCESS and code == 200 and data is Dictionary and data.get("available", false) == true:
		model = str(data.get("model", model))
		_status = "Luna · live" if data.get("verified_inference", false) == true else "Luna · ready for first scene"
		_set_available(true)
		_process_next()
	else:
		_pause(_failure_status(code, data), _retry_seconds(data))


func _on_completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if _current.is_empty():
		return
	var data: Variant = _parse_json(body.get_string_from_utf8())
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		_fail_current("Cloud response failed (%d)" % code)
		_pause(_failure_status(code, data), _retry_seconds(data))
		return
	var decoded := decode_response(data)
	if decoded.is_empty():
		_fail_current("Cloud output was not a JSON object")
		_pause("Demo · invalid cloud response", 30)
		return
	var callback: Callable = _current["callback"]
	_current = {}
	_status = "Luna · live"
	callback.call(true, decoded, "")
	_process_next()


static func decode_response(data: Variant) -> Dictionary:
	if not data is Dictionary:
		return {}
	var message: Variant = data.get("message", {})
	if not message is Dictionary:
		return {}
	var content: Variant = _parse_json(str(message.get("content", "")))
	return content if content is Dictionary else {}


static func _parse_json(value: String) -> Variant:
	var parser := JSON.new()
	return parser.data if parser.parse(value) == OK else null


func _failure_status(code: int, data: Variant) -> String:
	var state := ""
	if data is Dictionary:
		state = str(data.get("status", data.get("error", "")))
	if code == 401 or code == 403 or "auth" in state or "sign" in state:
		return "Demo · sign in to enable Luna"
	if code == 429 or "quota" in state or "limit" in state:
		return "Demo · Luna quota paused"
	return "Demo · cloud unavailable"


func _retry_seconds(data: Variant) -> int:
	if data is Dictionary:
		return clampi(int(data.get("retry_after", 30)), 15, 300)
	return 30


func _fail_current(reason: String) -> void:
	if _current.is_empty():
		return
	var callback: Callable = _current["callback"]
	_current = {}
	callback.call(false, {}, reason)


func _pause(status: String, seconds: int) -> void:
	_status = status
	_retry_at_ms = Time.get_ticks_msec() + seconds * 1000
	_set_available(false)
	# Release all waiting actors; never accumulate a backlog during quota/auth loss.
	while not _queue.is_empty():
		var entry: Dictionary = _queue.pop_front()
		entry["callback"].call(false, {}, status)


func _set_available(value: bool) -> void:
	is_available = value
	status_changed.emit(value)


func drain_queue() -> void:
	if _http:
		_http.cancel_request()
	if _health_http:
		_health_http.cancel_request()
	_set_available(false)
	_fail_current("Backend switched")
	while not _queue.is_empty():
		var entry: Dictionary = _queue.pop_front()
		entry["callback"].call(false, {}, "Backend switched")
