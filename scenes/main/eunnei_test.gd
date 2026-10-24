extends Node2D
## Integration checks for the aquarium's actual cast, prompt boundaries and events.

var _passed := 0
var _failed := 0


func _ready() -> void:
	ProducerEconomy.meta_persistence_enabled = false
	SaveManager.episode_snapshots_enabled = false
	GoalManager.auto_enabled = false
	WhodunitDirector.auto_enabled = false
	ImpactLog.auto_enabled = false
	SynergyManager.auto_enabled = false
	SecretManager.auto_assign_enabled = false
	SecretManager.auto_admit_enabled = false
	TimeManager.set_speed(0)
	LLMManager.is_available = false
	ConfessionalDirector._cooldown = 9999.0
	add_child(preload("res://scenes/world/office.tscn").instantiate())
	for agent in AgentManager.agents:
		agent.smart_brain.force_heuristic = true
	await get_tree().process_frame
	_run()
	print("EUNNEI: %d passed, %d failed" % [_passed, _failed])
	get_tree().quit(0 if _failed == 0 else 1)


func _run() -> void:
	_check("the default scene loads all six authored adults", AgentManager.agents.size() == 6)
	var ivo := AgentManager.get_agent_by_name("Ivo Splice")
	var leon := AgentManager.get_agent_by_name("Leon Rusk")
	_check("named cast is actually instantiated", ivo != null and leon != null and AgentManager.get_agent_by_name("Mara Vell") != null)
	if ivo == null or leon == null:
		return
	var restored := PersonalityProfile.from_dict(ivo.personality.to_dict())
	_check("private conviction survives the save representation", restored.private_context == ivo.personality.private_context and "software" in restored.private_context)
	_check("public description excludes private conviction", not "software" in ivo.personality.description.to_lower())

	ivo.memory.memories.clear()
	leon.memory.memories.clear()
	ivo.memory.add_observation("Ivo remembers the marmalade incident.", 6.0)
	leon.memory.add_observation("Leon alone remembers the aquamarine umbrella.", 6.0)
	var prompt := PromptBuilder.build("conversation", {
		"name": ivo.agent_name,
		"description": ivo.personality.description,
		"private_context": EunneiStory.private_brief(ivo.personality),
		"memories": EunneiStory.memories_for(ivo, "incident umbrella"),
		"personality": ivo.personality.get_trait_lines(),
		"speech_style": ivo.personality.speech_style,
		"mood": "calm", "voice_block": "", "other_name": leon.agent_name,
		"other_description": leon.personality.description,
		"relationship": "colleague", "affinity": 0,
		"secret_line": "", "gossip_line": "", "history": "",
	})
	_check("dialogue sees its speaker's private conviction and recalled event", ivo.personality.private_context in prompt and "marmalade" in prompt)
	_check("dialogue cannot see the listener's private brief or unshared memory", not leon.personality.private_context in prompt and not "aquamarine umbrella" in prompt)
	_check("the world premise reaches runtime prompts", "No authoritative definition" in prompt and not "{memories}" in prompt)

	var premiere := PremiereDirector.new()
	add_child(premiere)
	premiere._seed_eunnei_office()
	var orientation_count := 0
	for agent in AgentManager.agents:
		for memory in agent.memory.memories:
			if memory.narrative_thread == "eunnei_orientation":
				orientation_count += 1
	_check("premiere plants the common bulletin in six separate memories", orientation_count == 6)
	var attraction: RelationshipEntry = ivo.relationships.get_relationship(leon.agent_name)
	_check("premiere attraction is state, without inventing a marriage", attraction.romantic_interest >= 25.0 and attraction.relationship_status == RelationshipEntry.Status.NONE)

	var count := 0
	for definition in EventManager.get_available_events():
		definition.probability = 0.0
		if definition.event_id.begins_with("eunnei_"):
			count += 1
	_check("all seven recurring story incidents load in the real catalog", count == 7)
	_check("White Review triggers through the real event engine", EventManager.trigger_event("eunnei_white_review"))
	var witnesses := 0
	for agent in AgentManager.agents:
		for memory in agent.memory.memories:
			if "attended the White Review" in memory.description:
				witnesses += 1
	_check("a global incident becomes six actual remembered experiences", witnesses == 6)

	# Isolate the nearby selection so the actual consequence is deterministic.
	for agent in AgentManager.agents:
		agent.global_position = Vector2(1000, 1000)
	ivo.global_position = Vector2(40, 40)
	leon.global_position = Vector2(50, 40)
	var affinity_before := attraction.affinity
	_check("sample dispute triggers", EventManager.trigger_event("eunnei_custody", [ivo]))
	_check("sample dispute changes the selected actors' relationship", is_equal_approx(attraction.affinity, affinity_before - 6.0))
	var disputed := false
	for memory in ivo.memory.memories:
		if "argued with Leon Rusk over custody" in memory.description:
			disputed = true
	_check("the same dispute is remembered with the actual other actor", disputed)


func _check(label: String, passed: bool) -> void:
	if passed:
		_passed += 1
		print("  PASS ", label)
	else:
		_failed += 1
		print("  FAIL ", label)
