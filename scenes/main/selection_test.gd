extends Node2D

var passed := 0
var failed := 0

func _ready() -> void:
	ProducerEconomy.meta_persistence_enabled = false
	SaveManager.episode_snapshots_enabled = false
	SaveManager.skip_auto_load = true
	GoalManager.auto_enabled = false
	WhodunitDirector.auto_enabled = false
	SecretManager.auto_assign_enabled = false
	SecretManager.auto_admit_enabled = false
	TimeManager.set_speed(0)
	var main := preload("res://scenes/main/main.tscn").instantiate()
	add_child(main)
	await get_tree().process_frame
	await get_tree().process_frame
	main.get_node("GameCamera").enabled = false
	for actor in AgentManager.agents:
		actor.set_physics_process(false)
		actor.smart_brain.force_heuristic = true
		actor.position = Vector2(600, 250)
	var a: Node2D = AgentManager.agents[0]
	var b: Node2D = AgentManager.agents[1]
	a.position = Vector2(80, 150)
	b.position = Vector2(140, 150)
	var panel: ProducerPanel = main.get_node("HUD")._producer_panel
	await get_tree().physics_frame
	await get_tree().process_frame
	EventBus.agent_deselected.emit()
	_check("physics picking is enabled", get_viewport().physics_object_picking)
	await _click(a.get_global_transform_with_canvas().origin)
	_check("real viewport click selects a character", GameManager.selected_agent == a)
	panel.open()
	await get_tree().create_timer(0.2).timeout
	_check("Producer inherits clicked subject", panel._agent == a and a.agent_name in panel._subject.text)
	_check("dropdown lists all living characters plus prompt", panel._subject_picker.item_count == AgentManager.agents.size() + 1)
	await _click(b.get_global_transform_with_canvas().origin)
	_check("click outside the open panel changes its subject", GameManager.selected_agent == b and panel._agent == b)
	var index := 0
	for i in range(1, panel._subject_picker.item_count):
		if panel._subject_picker.get_item_text(i) == a.agent_name:
			index = i
	panel._subject_picker.select(index)
	panel._subject_picker.item_selected.emit(index)
	_check("dropdown updates global selection and Producer", GameManager.selected_agent == a and panel._agent == a)
	panel.close()
	panel.open()
	_check("selection survives closing and reopening Producer", panel._agent == a and panel._subject_picker.selected == index)
	b.is_dead = true
	panel._refresh_subject()
	_check("dropdown excludes unavailable characters", panel._subject_picker.item_count == AgentManager.agents.size())
	panel._subject_picker.select(0)
	panel._subject_picker.item_selected.emit(0)
	_check("prompt clears selection consistently", panel._agent == null and GameManager.selected_agent == null)
	panel.close()
	await _click(a.get_global_transform_with_canvas().origin + Vector2(0, -10))
	_check("clicking the upper sprite also selects", GameManager.selected_agent == a)
	print("SELECTION: %d passed, %d failed" % [passed, failed])
	get_tree().quit(0 if failed == 0 else 1)

func _click(pos: Vector2) -> void:
	var motion := InputEventMouseMotion.new()
	motion.position = pos
	get_viewport().push_input(motion, true)
	var down := InputEventMouseButton.new()
	down.button_index = MOUSE_BUTTON_LEFT
	down.position = pos
	down.pressed = true
	get_viewport().push_input(down, true)
	await get_tree().physics_frame
	await get_tree().process_frame
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.position = pos
	get_viewport().push_input(up, true)
	await get_tree().physics_frame
	await get_tree().process_frame

func _check(label: String, ok: bool) -> void:
	print(("PASS " if ok else "FAIL ") + label)
	if ok: passed += 1
	else: failed += 1
