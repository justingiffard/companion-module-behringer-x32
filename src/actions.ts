import InstanceSkel = require('../../../instance_skel')
import { CompanionAction, CompanionActionEvent, CompanionActions } from '../../../instance_skel_types'
import { X32State } from './state'
import { X32Config } from './config'
import { trimToFloat, headampGainToFloat, floatToDB } from './util'
import {
	CHOICES_TAPE_FUNC,
	CHOICES_COLOR,
	GetTargetChoices,
	MUTE_TOGGLE,
	GetMuteGroupChoices,
	CHOICES_MUTE_GROUP,
	GetChannelSendChoices,
	convertChoices,
	CHOICES_ON_OFF,
	GetBusSendChoices,
	FaderLevelChoice,
	MuteChoice,
	HeadampGainChoice,
	GetHeadampChoices,
	GetOscillatorDestinations,
	FaderLevelDeltaChoice,
	FadeDurationChoice,
	GetLevelsChoiceConfigs,
} from './choices'
// eslint-disable-next-line node/no-extraneous-import
import * as osc from 'osc'
import { MutePath, MainPath, MainFaderPath, SendChannelToBusPath, SendBusToMatrixPath } from './paths'
import { SetRequired } from 'type-fest'
import { X32Transitions } from './transitions'
import moment = require('moment')

export enum ActionId {
	Mute = 'mute',
	MuteGroup = 'mute_grp',
	MuteChannelSend = 'mute_channel_send',
	MuteBusSend = 'mute_bus_send',
	FaderLevel = 'fad',
	FaderLevelStore = 'fader_store',
	FaderLevelRestore = 'fader_restore',
	FaderLevelDelta = 'fader_delta',
	ChannelSendLevel = 'level_channel_send',
	ChannelSendLevelDelta = 'level_channel_send_delta',
	ChannelSendLevelStore = 'level_channel_store',
	ChannelSendLevelRestore = 'level_channel_restore',
	BusSendLevel = 'level_bus_send',
	BusSendLevelDelta = 'level_bus_send_delta',
	BusSendLevelStore = 'level_bus_store',
	BusSendLevelRestore = 'level_bus_restore',
	InputTrim = 'input_trim',
	// InputGain = 'input_gain',
	HeadampGain = 'headamp_gain',
	Label = 'label',
	Color = 'color',
	GoCue = 'go_cue',
	GoScene = 'go_scene',
	GoSnip = 'go_snip',
	Select = 'select',
	Solo = 'solo',
	ClearSolo = 'clear-solo',
	Tape = 'tape',
	TalkbackTalk = 'talkback_talk',
	OscillatorEnable = 'oscillator-enable',
	OscillatorDestination = 'oscillator-destination',
	SyncClock = 'sync_clock',
	SoloMono = 'solo-mono',
	SoloDim = 'solo_dim',
	SoloDimAttenuation = 'solo_dim_attenuation',
	MonitorLevel = 'monitor-level',
	SendsOnFader = 'sends-on-fader',
	ChannelBank = 'channel-bank-full',
	GroupBank = 'group-bank-full',
	ChannelBankCompact = 'channel-bank-compact',
	GroupBankCompact = 'group-bank-compact',
	BusSendBank = 'bus-send-bank',
	UserBank = 'user-bank',
	Screens = 'screens',
	MuteGroupScreen = 'mute-group-screen',
	UtilityScreen = 'utility-screen',
	ChannelPage = 'channel-page',
	MeterPage = 'meter-page',
	RoutePage = 'route-page',
	SetupPage = 'setup-page',
	LibPage = 'library-page',
	FxPage = 'effects-page',
	MonPage = 'monitor-page',
	USBPage = 'usb-page',
	ScenePage = 'scene-page',
	AssignPage = 'assign-page',
	NextPrevPage = 'next-previous-page',
	DCASpill = 'dca_spill',
}

type CompanionActionWithCallback = SetRequired<CompanionAction, 'callback'>

export function GetActionsList(
	self: InstanceSkel<X32Config>,
	transitions: X32Transitions,
	state: X32State,
	ensureLoaded: (path: string) => void
): CompanionActions {
	const levelsChoices = GetLevelsChoiceConfigs(state)
	const muteGroups = GetMuteGroupChoices(state)
	const selectChoices = GetTargetChoices(state, { skipDca: true, includeMain: true, numericIndex: true })
	const soloChoices = GetTargetChoices(state, { includeMain: true, numericIndex: true })
	const dcaSpillChoices = [
		{ id: '0', label: 'None' },
		...GetTargetChoices(state, { skipBus: true, skipMatrix: true, skipInputs: true, numericIndex: true }).map((a) => {
			return { id: `${+a.id + 1}`, label: a.label }
		}),
	]

	const sendOsc = (cmd: string, arg: osc.MetaArgument): void => {
		try {
			// HACK: We send commands on a different port than we run /xremote on, so that we get change events for what we send.
			// Otherwise we can have no confirmation that a command was accepted
			if (self.config.host) {
				self.oscSend(self.config.host, 10023, cmd, [arg])
			}
		} catch (e) {
			self.log('error', `Command send failed: ${e}`)
		}
	}
	const getOptNumber = (action: CompanionActionEvent, key: string, defVal?: number): number => {
		const rawVal = action.options[key]
		if (defVal !== undefined && rawVal === undefined) return defVal
		const val = Number(rawVal)
		if (isNaN(val)) {
			throw new Error(`Invalid option '${key}'`)
		}
		return val
	}
	// const getOptBool = (key: string): boolean => {
	//   return !!opt[key]
	// }
	const getResolveOnOffMute = (
		action: CompanionActionEvent,
		cmd: string,
		cmdIsCalledOn: boolean,
		prop: 'mute' | 'on' = 'mute'
	): number => {
		const onState = getOptNumber(action, prop)
		if (onState === MUTE_TOGGLE) {
			const currentState = state.get(cmd)
			const currentVal = currentState && currentState[0]?.type === 'i' && currentState[0]?.value
			if (typeof currentVal === 'number') {
				return currentVal === 0 ? 1 : 0
			} else {
				// default to off
				return cmdIsCalledOn ? 0 : 1
			}
		} else {
			return onState
		}
	}

	const actions: { [id in ActionId]: CompanionActionWithCallback | undefined } = {
		[ActionId.Mute]: {
			label: 'Set mute',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				MuteChoice,
			],
			callback: (action): void => {
				const cmd = MutePath(action.options.target as string)
				sendOsc(cmd, {
					type: 'i',
					value: getResolveOnOffMute(action, cmd, true),
				})
			},
			subscribe: (evt): void => {
				if (evt.options.mute === MUTE_TOGGLE) {
					ensureLoaded(MutePath(evt.options.target as string))
				}
			},
		},
		[ActionId.MuteGroup]: {
			label: 'Mute Group ON/OFF',
			options: [
				{
					type: 'dropdown',
					label: 'Mute Group',
					id: 'target',
					...convertChoices(muteGroups),
				},
				{
					type: 'dropdown',
					label: 'Mute / Unmute',
					id: 'mute',
					...convertChoices(CHOICES_MUTE_GROUP),
				},
			],
			callback: (action): void => {
				const cmd = action.options.target as string
				sendOsc(cmd, {
					type: 'i',
					value: getResolveOnOffMute(action, cmd, false),
				})
			},
			subscribe: (evt): void => {
				if (evt.options.mute === MUTE_TOGGLE) {
					ensureLoaded(evt.options.target as string)
				}
			},
		},
		[ActionId.MuteChannelSend]: {
			label: 'Set mute for channel to bus send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(GetChannelSendChoices(state, 'on')),
				},
				MuteChoice,
			],
			callback: (action): void => {
				const cmd = `${MainPath(action.options.source as string)}/${action.options.target}`
				sendOsc(cmd, {
					type: 'i',
					value: getResolveOnOffMute(action, cmd, true),
				})
			},
			subscribe: (evt): void => {
				if (evt.options.mute === MUTE_TOGGLE) {
					ensureLoaded(`${MainPath(evt.options.source as string)}/${evt.options.target}`)
				}
			},
		},
		[ActionId.MuteBusSend]: {
			label: 'Set mute for bus to matrix send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.busSendSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(GetBusSendChoices(state)),
				},
				MuteChoice,
			],
			callback: (action): void => {
				const cmd = `${MainPath(action.options.source as string)}/${action.options.target}/on`
				sendOsc(cmd, {
					type: 'i',
					value: getResolveOnOffMute(action, cmd, true),
				})
			},
			subscribe: (evt): void => {
				if (evt.options.mute === MUTE_TOGGLE) {
					ensureLoaded(`${MainPath(evt.options.source as string)}/${evt.options.target}/on`)
				}
			},
		},
		[ActionId.FaderLevel]: {
			label: 'Set fader level',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				FaderLevelChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = MainFaderPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				transitions.run(cmd, currentVal, getOptNumber(action, 'fad'), getOptNumber(action, 'fadeDuration', 0))
			},
			subscribe: (evt): void => {
				// In case we have a fade time
				ensureLoaded(MainFaderPath(evt.options))
			},
		},
		[ActionId.FaderLevelStore]: {
			label: 'Store fader level',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = MainFaderPath(action.options)
					const currentState = state.get(cmd)
					const currentVal =
						currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
					if (currentVal !== undefined) {
						state.setPressValue(`${info.page}-${info.bank}-${cmd}`, currentVal)
					}
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(MainFaderPath(evt.options))
			},
		},
		[ActionId.FaderLevelRestore]: {
			label: 'Restore fader level',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				FadeDurationChoice,
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = MainFaderPath(action.options)
					const storedVal = state.popPressValue(`${info.page}-${info.bank}-${cmd}`)
					if (storedVal !== undefined) {
						const currentState = state.get(cmd)
						const currentVal =
							currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
						if (currentVal !== undefined) {
							transitions.run(cmd, currentVal, storedVal, getOptNumber(action, 'fadeDuration', 0))
						}
					}
				}
			},
		},
		[ActionId.FaderLevelDelta]: {
			label: 'Adjust fader level',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				FaderLevelDeltaChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = MainFaderPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				if (typeof currentVal === 'number') {
					transitions.run(
						cmd,
						currentVal,
						currentVal + getOptNumber(action, 'delta'),
						getOptNumber(action, 'fadeDuration', 0)
					)
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(MainFaderPath(evt.options))
			},
		},
		[ActionId.ChannelSendLevel]: {
			label: 'Set level of channel to bus send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channelSendTargets),
				},
				FaderLevelChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = SendChannelToBusPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				transitions.run(cmd, currentVal, getOptNumber(action, 'fad'), getOptNumber(action, 'fadeDuration', 0))
			},
			subscribe: (evt): void => {
				// In case we have a fade time
				ensureLoaded(SendChannelToBusPath(evt.options))
			},
		},
		[ActionId.ChannelSendLevelDelta]: {
			label: 'Adjust level of channel to bus send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channelSendTargets),
				},
				FaderLevelDeltaChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = SendChannelToBusPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				if (typeof currentVal === 'number') {
					transitions.run(
						cmd,
						currentVal,
						currentVal + getOptNumber(action, 'delta'),
						getOptNumber(action, 'fadeDuration', 0)
					)
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(SendChannelToBusPath(evt.options))
			},
		},
		[ActionId.ChannelSendLevelStore]: {
			label: 'Store level of channel to bus send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channelSendTargets),
				},
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = SendChannelToBusPath(action.options)
					const currentState = state.get(cmd)
					const currentVal =
						currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
					if (currentVal !== undefined) {
						state.setPressValue(`${info.page}-${info.bank}-${cmd}`, currentVal)
					}
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(SendChannelToBusPath(evt.options))
			},
		},
		[ActionId.ChannelSendLevelRestore]: {
			label: 'Restore level of channel to bus send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channelSendTargets),
				},
				FadeDurationChoice,
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = SendChannelToBusPath(action.options)
					const storedVal = state.popPressValue(`${info.page}-${info.bank}-${cmd}`)
					if (storedVal !== undefined) {
						const currentState = state.get(cmd)
						const currentVal =
							currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
						if (currentVal !== undefined) {
							transitions.run(cmd, currentVal, storedVal, getOptNumber(action, 'fadeDuration', 0))
						}
					}
				}
			},
		},
		[ActionId.BusSendLevel]: {
			label: 'Set level of bus to matrix send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.busSendSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.busSendTargets),
				},
				FaderLevelChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = SendBusToMatrixPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				transitions.run(cmd, currentVal, getOptNumber(action, 'fad'), getOptNumber(action, 'fadeDuration', 0))
			},
			subscribe: (evt): void => {
				// In case we have a fade time
				ensureLoaded(SendBusToMatrixPath(evt.options))
			},
		},
		[ActionId.BusSendLevelDelta]: {
			label: 'Adjust level of bus to matrix send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.busSendSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.busSendTargets),
				},
				FaderLevelDeltaChoice,
				FadeDurationChoice,
			],
			callback: (action): void => {
				const cmd = SendBusToMatrixPath(action.options)
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				if (typeof currentVal === 'number') {
					transitions.run(
						cmd,
						currentVal,
						currentVal + getOptNumber(action, 'delta'),
						getOptNumber(action, 'fadeDuration', 0)
					)
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(SendBusToMatrixPath(evt.options))
			},
		},
		[ActionId.BusSendLevelStore]: {
			label: 'Store level of bus to matrix send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.busSendSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.busSendTargets),
				},
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = SendBusToMatrixPath(action.options)
					const currentState = state.get(cmd)
					const currentVal =
						currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
					if (currentVal !== undefined) {
						state.setPressValue(`${info.page}-${info.bank}-${cmd}`, currentVal)
					}
				}
			},
			subscribe: (evt): void => {
				ensureLoaded(SendBusToMatrixPath(evt.options))
			},
		},
		[ActionId.BusSendLevelRestore]: {
			label: 'Restore level of bus to matrix send',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					...convertChoices(levelsChoices.busSendSources),
				},
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.busSendTargets),
				},
				FadeDurationChoice,
			],
			callback: (action, info): void => {
				if (info) {
					const cmd = SendBusToMatrixPath(action.options)
					const storedVal = state.popPressValue(`${info.page}-${info.bank}-${cmd}`)
					if (storedVal !== undefined) {
						const currentState = state.get(cmd)
						const currentVal =
							currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
						if (currentVal !== undefined) {
							transitions.run(cmd, currentVal, storedVal, getOptNumber(action, 'fadeDuration', 0))
						}
					}
				}
			},
		},
		[ActionId.InputTrim]: {
			label: 'Set input trim',
			options: [
				{
					type: 'dropdown',
					label: 'Input',
					id: 'input',
					...convertChoices(levelsChoices.allSources),
				},
				{
					type: 'number',
					label: 'Trim',
					id: 'trim',
					range: true,
					required: true,
					default: 0,
					step: 0.1,
					min: -18,
					max: 18,
				},
			],
			callback: (action): void => {
				sendOsc(`${action.options.input}/preamp/trim`, {
					type: 'f',
					value: trimToFloat(getOptNumber(action, 'trim')),
				})
			},
		},
		[ActionId.HeadampGain]: {
			label: 'Set Headamp gain',
			options: [
				{
					type: 'dropdown',
					label: 'Headamp',
					id: 'headamp',
					...convertChoices(GetHeadampChoices()),
				},
				HeadampGainChoice,
			],
			callback: (action): void => {
				sendOsc(`${action.options.headamp}/gain`, {
					type: 'f',
					value: headampGainToFloat(getOptNumber(action, 'gain')),
				})
			},
		},
		[ActionId.Label]: {
			label: 'Set label',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				{
					type: 'textinput',
					label: 'Label',
					id: 'lab',
					default: '',
				},
			],
			callback: (action): void => {
				sendOsc(`${action.options.target}/config/name`, {
					type: 's',
					value: `${action.options.lab}`,
				})
			},
		},

		[ActionId.Color]: {
			label: 'Set color',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					...convertChoices(levelsChoices.channels),
				},
				{
					type: 'dropdown',
					label: 'color',
					id: 'col',
					...convertChoices(CHOICES_COLOR),
				},
			],
			callback: (action): void => {
				sendOsc(`${action.options.target}/config/color`, {
					type: 'i',
					value: getOptNumber(action, 'col'),
				})
			},
		},

		[ActionId.GoCue]: {
			label: 'Load Console Cue',
			options: [
				{
					type: 'number',
					label: 'Cue Nr 0-99',
					id: 'cue',
					default: 0,
					min: 0,
					max: 99,
				},
			],
			callback: (action): void => {
				sendOsc(`/-action/gocue`, {
					type: 'i',
					value: getOptNumber(action, 'cue'),
				})
			},
		},
		[ActionId.GoScene]: {
			label: 'Load Console Scene',
			options: [
				{
					type: 'number',
					label: 'scene Nr 0-99',
					id: 'scene',
					default: 0,
					min: 0,
					max: 99,
				},
			],
			callback: (action): void => {
				sendOsc(`/-action/goscene`, {
					type: 'i',
					value: getOptNumber(action, 'scene'),
				})
			},
		},
		[ActionId.GoSnip]: {
			label: 'Load Console snippet',
			options: [
				{
					type: 'number',
					label: 'Snippet Nr 0-99',
					id: 'snip',
					default: 0,
					min: 0,
					max: 99,
				},
			],
			callback: (action): void => {
				sendOsc(`/-action/gosnippet`, {
					type: 'i',
					value: getOptNumber(action, 'snip'),
				})
			},
		},
		[ActionId.Select]: {
			label: 'Select',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'select',
					...convertChoices(selectChoices),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/selidx`, {
					type: 'i',
					value: getOptNumber(action, 'select'),
				})
			},
		},
		[ActionId.Solo]: {
			label: 'Solo On/Off',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'solo',
					...convertChoices(soloChoices),
				},
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const ch = `${getOptNumber(action, 'solo') + 1}`.padStart(2, '0')
				const cmd = `/-stat/solosw/${ch}`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					const ch = `${getOptNumber(evt, 'solo') + 1}`.padStart(2, '0')
					ensureLoaded(`/-stat/solosw/${ch}`)
				}
			},
		},
		[ActionId.ClearSolo]: {
			label: 'Clear Solo',
			options: [],
			callback: (): void => {
				sendOsc(`/-action/clearsolo`, {
					type: 'i',
					value: 1,
				})
			},
		},
		[ActionId.Tape]: {
			label: 'Tape Operation',
			options: [
				{
					type: 'dropdown',
					label: 'Function',
					id: 'tFunc',
					...convertChoices(CHOICES_TAPE_FUNC),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/tape/state`, {
					type: 'i',
					value: getOptNumber(action, 'tFunc'),
				})
			},
		},
		[ActionId.TalkbackTalk]: {
			label: 'Talkback Talk',
			options: [
				{
					type: 'dropdown',
					label: 'Function',
					id: 'channel',
					...convertChoices([
						{
							id: 'A',
							label: 'A',
						},
						{
							id: 'B',
							label: 'B',
						},
					]),
				},
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/talk/${action.options.channel}`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/-stat/talk/${evt.options.channel}`)
				}
			},
		},
		[ActionId.OscillatorEnable]: {
			label: 'Oscillator Enable',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/osc/on`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/-stat/osc/on`)
				}
			},
		},
		[ActionId.OscillatorDestination]: {
			label: 'Oscillator Destination',
			options: [
				{
					type: 'dropdown',
					label: 'destination',
					id: 'destination',
					...convertChoices(GetOscillatorDestinations(state)),
				},
			],
			callback: (action): void => {
				sendOsc(`/config/osc/dest`, {
					type: 'i',
					value: getOptNumber(action, 'destination'),
				})
			},
		},
		[ActionId.SoloMono]: {
			label: 'Solo Mono',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/config/solo/mono`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/config/solo/mono`)
				}
			},
		},
		[ActionId.SoloDim]: {
			label: 'Solo Dim',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/config/solo/dim`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/config/solo/dim`)
				}
			},
		},
		[ActionId.SoloDimAttenuation]: {
			label: 'Set Dim Attenuation',
			options: [
				{
					type: 'number',
					label: 'Dim Attenuation',
					id: 'dimAtt',
					range: true,
					required: true,
					default: -10,
					step: 1,
					min: -40,
					max: 0,
				},
			],
			callback: (action): void => {
				sendOsc(`/config/solo/dimatt`, {
					type: 'f',
					value: getOptNumber(action, 'dimAtt') / 40 + 1,
				})
			},
		},
		[ActionId.MonitorLevel]: {
			label: 'Set monitor level',
			options: [FaderLevelChoice, FadeDurationChoice],
			callback: (action): void => {
				const cmd = `/config/solo/level`
				const currentState = state.get(cmd)
				const currentVal = currentState && currentState[0]?.type === 'f' ? floatToDB(currentState[0]?.value) : undefined
				transitions.run(cmd, currentVal, getOptNumber(action, 'fad'), getOptNumber(action, 'fadeDuration', 0))
			},
			subscribe: (): void => {
				ensureLoaded(`/config/solo/level`)
			},
		},
		[ActionId.SyncClock]: {
			label: 'Sync console time',
			options: [],
			callback: (): void => {
				sendOsc(`/-action/setclock`, {
					type: 's',
					value: moment().format('YYYYMMDDHHmmss'),
				})
			},
		},
		[ActionId.ChannelBank]: {
			label: 'Select active channel bank (X32/M32)',
			description:
				'Select a channel bank for the left hand side of your console. Please note this action is for the X32 and M32. For X32 Compact/X32 Producer/M32R please use the X32 Compact/X32 Producer/M32R action',
			options: [
				{
					type: 'dropdown',
					label: 'Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'CH 1 - 16',
						},
						{
							id: '1',
							label: 'CH 17 - 32',
						},
						{
							id: '2',
							label: 'AUX IN / USB / FX RTN',
						},
						{
							id: '3',
							label: 'BUS MASTERS',
						},
					]),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/chfaderbank`, {
					type: 'i',
					value: getOptNumber(action, 'bank'),
				})
			},
		},
		[ActionId.GroupBank]: {
			label: 'Select active group bank (X32/M32)',
			description:
				'Select a group bank for the right hand side of your console. Please note this action is for the X32 and M32. For X32 Compact/X32 Producer/M32R please use the X32 Compact/X32 Producer/M32R action',
			options: [
				{
					type: 'dropdown',
					label: 'Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'GROUP DCA 1 - 8',
						},
						{
							id: '1',
							label: 'BUS 1 - 8',
						},
						{
							id: '2',
							label: 'BUS 9 - 16',
						},
						{
							id: '3',
							label: 'MATRIX 1 - 6 / MAIN C',
						},
					]),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/grpfaderbank`, {
					type: 'i',
					value: getOptNumber(action, 'bank'),
				})
			},
		},
		[ActionId.ChannelBankCompact]: {
			label: 'Select active channel bank (X32 Compact/X32 Producer/M32R)',
			description:
				'Select a channel bank for the left hand side of your console. Please note this action is for X32 Compact/X32 Producer/M32R. For X32 or M32 please use the X32/M32 action',
			options: [
				{
					type: 'dropdown',
					label: 'Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'CH 1 - 8',
						},
						{
							id: '1',
							label: 'CH 9 - 16',
						},
						{
							id: '2',
							label: 'CH 17 - 24',
						},
						{
							id: '3',
							label: 'CH 25 - 32',
						},
						{
							id: '4',
							label: 'AUX IN / USB',
						},
						{
							id: '5',
							label: 'FX RTN',
						},
						{
							id: '6',
							label: 'BUS 1-8',
						},
						{
							id: '7',
							label: 'BUS 1-8',
						},
					]),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/chfaderbank`, {
					type: 'i',
					value: getOptNumber(action, 'bank'),
				})
			},
		},
		[ActionId.GroupBankCompact]: {
			label: 'Select active group bank (X32 Compact/X32 Producer/M32R)',
			description:
				'Select a group bank for the right hand side of your console. Please note this actions is for X32 Compact/X32 Producer/M32R. For X32 or M32 please use the X32/M32 action',
			options: [
				{
					type: 'dropdown',
					label: 'Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'GROUP DCA 1 - 8',
						},
						{
							id: '1',
							label: 'BUS 1 - 8',
						},
						{
							id: '2',
							label: 'BUS 9 - 16',
						},
						{
							id: '3',
							label: 'MATRIX 1 - 6 / MAIN C',
						},
						{
							id: '4',
							label: 'CH 1 - 8',
						},
						{
							id: '5',
							label: 'CH 9 - 16',
						},
						{
							id: '6',
							label: 'CH 17 - 24',
						},
						{
							id: '7',
							label: 'CH 25 - 32',
						},
						{
							id: '8',
							label: 'AUX IN / USB',
						},
						{
							id: '9',
							label: 'FX RTN',
						},
					]),
				},
			],
			callback: (action): void => {
				sendOsc(`/-stat/grpfaderbank`, {
					type: 'i',
					value: getOptNumber(action, 'bank'),
				})
			},
		},
		[ActionId.SendsOnFader]: {
			label: 'Sends on Fader/Fader Flip',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/sendsonfader`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/-stat/sendsonfader`)
				}
			},
		},
		[ActionId.BusSendBank]: {
			label: 'Bus send bank',
			options: [
				{
					type: 'dropdown',
					label: 'Send Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'Bus 1-4',
						},
						{
							id: '1',
							label: 'Bus 5-8',
						},
						{
							id: '2',
							label: 'Bus 9-12',
						},
						{
							id: '3',
							label: 'Bus 13-16',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/bussendbank`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'bank', 0),
				})
			},
		},
		[ActionId.UserBank]: {
			label: 'User Assign Bank',
			options: [
				{
					type: 'dropdown',
					label: 'User Bank',
					id: 'bank',
					...convertChoices([
						{
							id: '0',
							label: 'Set A',
						},
						{
							id: '1',
							label: 'Set B',
						},
						{
							id: '2',
							label: 'Set C',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/userbank`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'bank', 0),
				})
			},
		},
		[ActionId.Screens]: {
			label: 'Select active screen on console',
			options: [
				{
					type: 'dropdown',
					label: 'Screen',
					id: 'screen',
					...convertChoices([
						{
							id: '0',
							label: 'HOME',
						},
						{
							id: '1',
							label: 'METERS',
						},
						{
							id: '2',
							label: 'ROUTING',
						},
						{
							id: '3',
							label: 'SETUP',
						},
						{
							id: '4',
							label: 'LIBRARY',
						},
						{
							id: '5',
							label: 'EFFECTS',
						},
						{
							id: '6',
							label: 'MONITOR',
						},
						{
							id: '7',
							label: 'USB RECORDER',
						},
						{
							id: '8',
							label: 'SCENES',
						},
						{
							id: '9',
							label: 'ASSIGN',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/screen`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'screen', 0),
				})
			},
		},
		[ActionId.MuteGroupScreen]: {
			label: 'Mute Group Screen',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/mutegrp`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/-stat/screen/mutegrp`)
				}
			},
		},
		[ActionId.UtilityScreen]: {
			label: 'Utilities Screen',
			options: [
				{
					type: 'dropdown',
					label: 'On / Off',
					id: 'on',
					...convertChoices(CHOICES_ON_OFF),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/utils`
				const onState = getResolveOnOffMute(action, cmd, true, 'on')

				sendOsc(cmd, {
					type: 'i',
					value: onState,
				})
			},
			subscribe: (evt): void => {
				if (evt.options.on === MUTE_TOGGLE) {
					ensureLoaded(`/-stat/screen/utils`)
				}
			},
		},
		[ActionId.ChannelPage]: {
			label: 'Navigate to page on channel screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'HOME',
						},
						{
							id: '1',
							label: 'CONFIG',
						},
						{
							id: '2',
							label: 'GATE',
						},
						{
							id: '3',
							label: 'DYNAMICS',
						},
						{
							id: '4',
							label: 'EQ',
						},
						{
							id: '5',
							label: 'SENDS',
						},
						{
							id: '6',
							label: 'MAIN',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/CHAN/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 0 })
			},
		},
		[ActionId.MeterPage]: {
			label: 'Navigate to page on meters screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'CHANNEL',
						},
						{
							id: '1',
							label: 'MIX BUS',
						},
						{
							id: '2',
							label: 'AUX/FX',
						},
						{
							id: '3',
							label: 'IN/OUT',
						},
						{
							id: '4',
							label: 'RTA',
						},
						{
							id: '5',
							label: 'AUTOMIX',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/METER/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 1 })
			},
		},
		[ActionId.RoutePage]: {
			label: 'Navigate to page on route screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'INPUT',
						},
						{
							id: '1',
							label: 'AES-A',
						},
						{
							id: '2',
							label: 'AES-B',
						},
						{
							id: '3',
							label: 'CARD',
						},
						{
							id: '4',
							label: 'XLR',
						},
						{
							id: '5',
							label: 'PATCH OUT',
						},
						{
							id: '6',
							label: 'PATCH AUX',
						},
						{
							id: '7',
							label: 'PATCH P16',
						},
						{
							id: '8',
							label: 'PATCH USER',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/ROUTE/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 2 })
			},
		},
		[ActionId.SetupPage]: {
			label: 'Navigate to page on setup screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'GLOBAL',
						},
						{
							id: '1',
							label: 'CONFIG',
						},
						{
							id: '2',
							label: 'REMOTE',
						},
						{
							id: '3',
							label: 'NETWORK',
						},
						{
							id: '4',
							label: 'SCRIBBLE STRIPS',
						},
						{
							id: '5',
							label: 'PREAMPS',
						},
						{
							id: '6',
							label: 'CARD',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/SETUP/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 3 })
			},
		},
		[ActionId.LibPage]: {
			label: 'Navigate to page on library screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'CHANNEL',
						},
						{
							id: '1',
							label: 'EFFECTS',
						},
						{
							id: '2',
							label: 'ROUTING',
						},
						{
							id: '3',
							label: 'MONITOR',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/LIB/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 4 })
			},
		},
		[ActionId.FxPage]: {
			label: 'Navigate to page on effects screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'HOME',
						},
						{
							id: '1',
							label: 'FX1',
						},
						{
							id: '2',
							label: 'FX2',
						},
						{
							id: '3',
							label: 'FX3',
						},
						{
							id: '4',
							label: 'FX4',
						},
						{
							id: '5',
							label: 'FX5',
						},
						{
							id: '6',
							label: 'FX6',
						},
						{
							id: '7',
							label: 'FX7',
						},
						{
							id: '8',
							label: 'FX8',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/FX/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 5 })
			},
		},
		[ActionId.MonPage]: {
			label: 'Navigate to page on monitor screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'MONITOR',
						},
						{
							id: '1',
							label: 'TALK A',
						},
						{
							id: '2',
							label: 'TALK B',
						},
						{
							id: '3',
							label: 'OSCILLATOR',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/MON/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 6 })
			},
		},
		[ActionId.USBPage]: {
			label: 'Navigate to page on USB screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'HOME',
						},
						{
							id: '1',
							label: 'CONFIG',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/USB/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 7 })
			},
		},
		[ActionId.ScenePage]: {
			label: 'Navigate to page on scene screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'CUES',
						},
						{
							id: '1',
							label: 'SCENES',
						},
						{
							id: '2',
							label: 'SNIPPETS',
						},
						{
							id: '3',
							label: 'PARAMETER SAFE',
						},
						{
							id: '4',
							label: 'CHANNEL SAFE',
						},
						{
							id: '5',
							label: 'MIDI',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/SCENE/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 8 })
			},
		},
		[ActionId.AssignPage]: {
			label: 'Navigate to page on assign screen',
			options: [
				{
					type: 'dropdown',
					label: 'page',
					id: 'page',
					...convertChoices([
						{
							id: '0',
							label: 'Home',
						},
						{
							id: '1',
							label: 'SET A',
						},
						{
							id: '2',
							label: 'SET B',
						},
						{
							id: '3',
							label: 'SET C',
						},
					]),
				},
			],
			callback: (action): void => {
				const cmd = `/-stat/screen/ASSIGN/page`
				sendOsc(cmd, {
					type: 'i',
					value: getOptNumber(action, 'page', 0),
				})
				sendOsc('/-stat/screen/screen', { type: 'i', value: 9 })
			},
		},
		[ActionId.NextPrevPage]: {
			label: 'Navigate to the next or previous page',
			options: [
				{
					type: 'dropdown',
					label: 'Next/Prev',
					id: 'goto',
					...convertChoices([
						{
							id: '1',
							label: 'Next',
						},
						{
							id: '-1',
							label: 'Prev',
						},
					]),
				},
			],
			callback: (action): void => {
				const currentScreen = state.get('/-stat/screen/screen')
				const currentScreenIndex = currentScreen && currentScreen[0]?.type === 'i' ? Number(currentScreen[0]?.value) : 0
				let screen = undefined
				let pages = 0
				switch (currentScreenIndex) {
					case 1:
						screen = 'METER'
						pages = 6
						break
					case 2:
						screen = 'ROUTE'
						pages = 9
						break
					case 3:
						screen = 'SETUP'
						pages = 7
						break
					case 4:
						screen = 'LIB'
						pages = 4
						break
					case 5:
						screen = 'FX'
						pages = 9
						break
					case 6:
						screen = 'MON'
						pages = 4
						break
					case 7:
						screen = 'USB'
						pages = 2
						break
					case 8:
						screen = 'SCENE'
						pages = 6
						break
					case 9:
						screen = 'ASSIGN'
						pages = 5
						break
					case 0:
					default:
						screen = 'CHAN'
						pages = 7
						break
				}

				const cmd = `/-stat/screen/${screen}/page`
				const currentPage = state.get(cmd)
				const currentPageIndex = currentPage && currentPage[0]?.type === 'i' ? Number(currentPage[0]?.value) : 0
				let gotoPageIndex = currentPageIndex + Number(action.options.goto)
				if (gotoPageIndex < 0) gotoPageIndex = 0
				else if (gotoPageIndex >= pages) gotoPageIndex = pages - 1

				sendOsc(cmd, {
					type: 'i',
					value: gotoPageIndex,
				})

				//transitions.run(cmd, currentVal, getOptNumber(action, 'fad'), getOptNumber(action, 'fadeDuration', 0))
			},
			subscribe: (): void => {
				ensureLoaded('/-stat/screen/screen')
				ensureLoaded('/-stat/screen/CHAN/page')
				ensureLoaded('/-stat/screen/METER/page')
				ensureLoaded('/-stat/screen/SETUP/page')
				ensureLoaded('/-stat/screen/LIB/page')
				ensureLoaded('/-stat/screen/FX/page')
				ensureLoaded('/-stat/screen/MON/page')
				ensureLoaded('/-stat/screen/USB/page')
				ensureLoaded('/-stat/screen/SCENE/page')
				ensureLoaded('/-stat/screen/ASSIGN/page')
			},
		},
		[ActionId.DCASpill]: {
			label: 'Select DCA for DCA Spill on the console',
			options: [
				{
					type: 'dropdown',
					label: 'DCA',
					id: 'dca',
					...convertChoices(dcaSpillChoices),
				},
			],
			callback: (action): void => {
				const currentState = state.get('/-stat/dcaspill')
				const currentVal = currentState && currentState[0]?.type === 'i' ? currentState[0]?.value : undefined
				if (action.options.dca == currentVal) {
					sendOsc(`/-stat/dcaspill`, {
						type: 'i',
						value: 0,
					})
				} else {
					sendOsc(`/-stat/dcaspill`, {
						type: 'i',
						value: getOptNumber(action, 'dca'),
					})
				}
			},
			subscribe: (): void => {
				ensureLoaded(`/-stat/dcaspill`)
			},
		},
	}

	return actions
}
