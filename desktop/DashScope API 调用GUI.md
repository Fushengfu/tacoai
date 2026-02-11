本文介绍通过 OpenAI 兼容接口 或 DashScope API 调用GUI-Plus模型的输入与输出参数。

相关文档：界面交互专用模型（GUI-Plus）
# OpenAI 兼容
SDK 调用配置的base_url为：https://dashscope.aliyuncs.com/compatible-mode/v1

HTTP 调用配置的endpoint：POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions

您需要已获取API Key并配置API Key到环境变量。若通过OpenAI SDK进行调用，需要安装SDK。
请求体
非流式输出流式输出
PythonNode.jscurl
 
import os
from openai import OpenAI

messages = [
    {
        "role": "system",
        "content": """## 1. 核心角色 (Core Role)\n你是一个顶级的AI视觉操作代理。你的任务是分析电脑屏幕截图，理解用户的指令，然后将任务分解为单一、精确的GUI原子操作。\n## 2. [CRITICAL] JSON Schema & 绝对规则\n你的输出**必须**是一个严格符合以下规则的JSON对象。**任何偏差都将导致失败**。\n- **[R1] 严格的JSON**: 你的回复**必须**是且**只能是**一个JSON对象。禁止在JSON代码块前后添加任何文本、注释或解释。\n- **[R2] 严格的Parameters结构**:`thought`对象的结构: "在这里用一句话简要描述你的思考过程。例如：用户想打开浏览器，我看到了桌面上的Chrome浏览器图标，所以下一步是点击它。"\n- **[R3] 精确的Action值**: `action`字段的值**必须**是`## 3. 工具集`中定义的一个大写字符串（例如 `"CLICK"`, `"TYPE"`），不允许有任何前导/后置空格或大小写变化。\n- **[R4] 严格的Parameters结构**: `parameters`对象的结构**必须**与所选Action在`## 3. 工具集`中定义的模板**完全一致**。键名、值类型都必须精确匹配。\n## 3. 工具集 (Available Actions)\n### CLICK\n- **功能**: 单击屏幕。\n- **Parameters模板**:\n{\n"x": <integer>,\n"y": <integer>,\n"description": "<string, optional:  (可选) 一个简短的字符串，描述你点击的是什么，例如 "Chrome浏览器图标" 或 "登录按钮"。>"\n}\n### TYPE\n- **功能**: 输入文本。\n- **Parameters模板**:\n{\n"text": "<string>",\n"needs_enter": <boolean>\n}\n### SCROLL\n- **功能**: 滚动窗口。\n- **Parameters模板**:\n{\n"direction": "<'up' or 'down'>",\n"amount": "<'small', 'medium', or 'large'>"\n}\n### KEY_PRESS\n- **功能**: 按下功能键。\n- **Parameters模板**:\n{\n"key": "<string: e.g., 'enter', 'esc', 'alt+f4'>"\n}\n### FINISH\n- **功能**: 任务成功完成。\n- **Parameters模板**:\n{\n"message": "<string: 总结任务完成情况>"\n}\n### FAIL\n- **功能**: 任务无法完成。\n- **Parameters模板**:\n{\n"reason": "<string: 清晰解释失败原因>"\n}\n## 4. 思维与决策框架\n在生成每一步操作前，请严格遵循以下思考-验证流程：\n目标分析: 用户的最终目标是什么？\n屏幕观察 (Grounded Observation): 仔细分析截图。你的决策必须基于截图中存在的视觉证据。 如果你看不见某个元素，你就不能与它交互。\n行动决策: 基于目标和可见的元素，选择最合适的工具。\n构建输出:\na. 在thought字段中记录你的思考。\nb. 选择一个action。\nc. 精确复制该action的parameters模板，并填充值。\n最终验证 (Self-Correction): 在输出前，最后检查一遍：\n我的回复是纯粹的JSON吗？\naction的值是否正确无误（大写、无空格）？\nparameters的结构是否与模板100%一致？例如，对于CLICK，是否有独立的x和y键，并且它们的值都是整数？""" ,
    },
    {   "role": "user",
        "content": [{"type": "image_url","image_url": {"url": "https://img.alicdn.com/imgextra/i2/O1CN016iJ8ob1C3xP1s2M6z_!!6000000000026-2-tps-3008-1758.png"}},
                  {"type": "text", "text": "帮我打开浏览器。"}]},
 ]

client = OpenAI(
    # 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：api_key="sk-xxx",
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)

completion = client.chat.completions.create(
    model="gui-plus",
    messages=messages,
    stream=True,
    stream_options={"include_usage":True}
)
for chunk in completion:
    print(chunk.model_dump_json())
model string （必选）

模型名称。支持的模型：gui-plus。

messages array （必选）传递给大模型的上下文，按对话顺序排列。

消息类型

stream boolean （可选） 默认值为 false

是否以流式方式输出回复。

可选值：

false：等待模型生成完整回复后一次性返回。

true：模型边生成边返回数据块。客户端需逐块读取，以还原完整回复。

stream_options object （可选）

流式输出的配置项，仅在 stream 为 true 时生效。

属性

include_usage boolean （可选）默认值为 false

是否在最后一个数据块包含Token消耗信息。

可选值：

true：包含；

false：不包含。

max_tokens integer （可选）

用于限制模型输出的最大 Token 数。若生成内容超过此值，响应将被截断。

默认值与最大值均为模型的最大输出长度，请参见适用范围。

vl_high_resolution_images boolean （可选）默认值为false

是否将输入图像的像素上限提升至 16384 Token 对应的像素值。

vl_high_resolution_images为true，使用固定分辨率策略，像素上限固定为12845056，忽略 max_pixels 设置，超过此分辨率时会将图像总像素缩小至此上限内。

vl_high_resolution_images为false，像素上限由max_pixels决定，输入图像的像素超过max_pixels会将图像缩小至max_pixels内。模型的默认像素上限即max_pixels的默认值。

seed integer （可选）

随机数种子。用于确保在相同输入和参数下生成结果可复现。若调用时传入相同的 seed 且其他参数不变，模型将尽可能返回相同结果。

取值范围：[0,231−1]。

temperature float （可选） 默认值为0.01

采样温度，控制模型生成文本的多样性。

temperature越高，生成的文本更多样，反之，生成的文本更确定。

取值范围： [0, 2)

temperature与top_p均可以控制生成文本的多样性，建议只设置其中一个值。

top_p float （可选）默认值为0.01

核采样的概率阈值，控制模型生成文本的多样性。

top_p越高，生成的文本更多样。反之，生成的文本更确定。

取值范围：（0,1.0]

temperature与top_p均可以控制生成文本的多样性，建议只设置其中一个值。

top_k integer （可选）默认值为1

生成过程中采样候选集的大小。例如，取值为50时，仅将单次生成中得分最高的50个Token组成随机采样的候选集。取值越大，生成的随机性越高；取值越小，生成的确定性越高。取值为None或当top_k大于100时，表示不启用top_k策略，此时仅有top_p策略生效。

取值需要大于或等于0。

该参数非OpenAI标准参数。通过 Python SDK调用时，请放入 extra_body 对象中，配置方式为：extra_body={"top_k": xxx}；通过 Node.js SDK 或 HTTP 方式调用时，请作为顶层参数传递。

repetition_penalty float （可选）默认值为1.0

模型生成时连续序列中的重复度。提高repetition_penalty时可以降低模型生成的重复度，1.0表示不做惩罚。该参数对模型效果影响较大，建议保持默认值。

presence_penalty float （可选）

控制模型生成文本时的内容重复度。默认值为1.5

取值范围：[-2.0, 2.0]。正值降低重复度，负值增加重复度。

在创意写作或头脑风暴等需要多样性、趣味性或创造力的场景中，建议调高该值；在技术文档或正式文本等强调一致性与术语准确性的场景中，建议调低该值。

原理介绍

示例

stop string 或 array （可选）

用于指定停止词。当模型生成的文本中出现stop 指定的字符串或token_id时，生成将立即终止。

可传入敏感词以控制模型的输出。

stop为数组时，不可将token_id和字符串同时作为元素输入，比如不可以指定为["你好",104307]。
chat响应对象（非流式输出）
 
{
  "id": "chatcmpl-ef17511a-aceb-4c47-8757-13a87af2152d",
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "logprobs": null,
      "message": {
        "content": "```json\n{\"thought\": \"用户想要打开浏览器，我观察到屏幕截图中有一个Google Chrome的图标，其位置在右上角一排的最后一个。因此，下一步操作应该是点击这个Chrome浏览器图标来启动它。\", \"action\": \"click\", \"parameters\": {\"x\": 1086, \"y\": 129}}\n```",
        "refusal": null,
        "role": "assistant",
        "annotations": null,
        "audio": null,
        "function_call": null,
        "tool_calls": null
      }
    }
  ],
  "created": 1763451557,
  "model": "gui-plus",
  "object": "chat.completion",
  "service_tier": null,
  "system_fingerprint": null,
  "usage": {
    "completion_tokens": 78,
    "prompt_tokens": 2020,
    "total_tokens": 2098,
    "completion_tokens_details": {
      "accepted_prediction_tokens": null,
      "audio_tokens": null,
      "reasoning_tokens": null,
      "rejected_prediction_tokens": null,
      "text_tokens": 78
    },
    "prompt_tokens_details": {
      "audio_tokens": null,
      "cached_tokens": null,
      "image_tokens": 1244,
      "text_tokens": 776
    }
  }
}
id string

本次请求的唯一标识符。

choices array

模型生成内容的数组。

属性

finish_reason string

模型停止生成的原因。

有两种情况：

自然停止输出时为stop；

生成长度过长而结束为length。

index integer

当前对象在choices数组中的索引。

message object

模型输出的消息。

属性

content string

GUI任务的结果。

refusal string

该参数当前固定为null。

role string

消息的角色，固定为assistant。

audio object

该参数当前固定为null。

function_call object

该参数当前固定为null。

tool_calls array

该参数当前固定为null。

created integer

本次请求被创建时的时间戳。

model string

本次请求使用的模型。

object string

始终为chat.completion。

service_tier string

该参数当前固定为null。

system_fingerprint string

该参数当前固定为null。

usage object

本次请求的 Token 消耗信息。

属性

chat响应chunk对象（流式输出）
 
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content='', function_call=None, refusal=None, role='assistant', tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content='```', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content='json', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content=None, function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content='\n{"thought": "', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
...
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content=' 1086', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content=', "y":', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content=' 127', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason=None, index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-9f3c627a-b0fc-4160-a558-3cc2cc7aa988', choices=[Choice(delta=ChoiceDelta(content='}}\n```', function_call=None, refusal=None, role=None, tool_calls=None), finish_reason='stop', index=0, logprobs=None)], created=1763452343, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=None)
ChatCompletionChunk(id='chatcmpl-bdb03054-42a2-459b-8a7e-5b94b39626f2', choices=[], created=1763452463, model='gui-plus', object='chat.completion.chunk', service_tier=None, system_fingerprint=None, usage=CompletionUsage(completion_tokens=78, prompt_tokens=2020, total_tokens=2098, completion_tokens_details=CompletionTokensDetails(accepted_prediction_tokens=None, audio_tokens=None, reasoning_tokens=None, rejected_prediction_tokens=None, text_tokens=78), prompt_tokens_details=PromptTokensDetails(audio_tokens=None, cached_tokens=None, image_tokens=1244, text_tokens=776)))
id string

本次调用的唯一标识符。每个chunk对象有相同的 id。

choices array

模型生成内容的数组。若设置include_usage参数为true，则在最后一个chunk中为空。

属性

delta object

流式返回的输出内容。

属性

content string

翻译结果，qwen-mt-flash为增量式更新，qwen-mt-plus和qwen-mt-turbo为非增量式更新。

function_call object

该参数当前固定为null。

refusal object

该参数当前固定为null。

role string

消息对象的角色，只在第一个chunk中有值。

finish_reason string

模型停止生成的原因。有三种情况：

自然停止输出时为stop；

生成未结束时为null；

生成长度过长而结束为length。

index integer

当前响应在choices数组中的索引。

created integer

本次请求被创建时的时间戳。每个chunk有相同的时间戳。

model string

本次请求使用的模型。

object string

始终为chat.completion.chunk。

service_tier string

该参数当前固定为null。

system_fingerprintstring

该参数当前固定为null。

usage object

本次请求消耗的Token。只在include_usage为true时，在最后一个chunk返回。

属性

DashScope
HTTP 请求地址：POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation

SDK 调用：无需配置 base_url

您需要已获取API Key并配置API Key到环境变量。若通过DashScope SDK进行调用，需要安装DashScope SDK。
请求体
非流式输出流式输出
PythonJavacurl
 
import os
import dashscope

messages = [{
        "role": "system",
        "content": """## 1. 核心角色 (Core Role)你是一个顶级的AI视觉操作代理。你的任务是分析电脑屏幕截图，理解用户的指令，然后将任务分解为单一、精确的GUI原子操作。## 2. [CRITICAL] JSON Schema & 绝对规则你的输出**必须**是一个严格符合以下规则的JSON对象。**任何偏差都将导致失败**。- **[R1] 严格的JSON**: 你的回复**必须**是且**只能是**一个JSON对象。禁止在JSON代码块前后添加任何文本、注释或解释。- **[R2] 严格的Parameters结构**:`thought`对象的结构: "在这里用一句话简要描述你的思考过程。例如：用户想打开浏览器，我看到了桌面上的Chrome浏览器图标，所以下一步是点击它。"- **[R3] 精确的Action值**: `action`字段的值**必须**是`## 3. 工具集`中定义的一个大写字符串（例如 `"CLICK"`, `"TYPE"`），不允许有任何前导/后置空格或大小写变化。- **[R4] 严格的Parameters结构**: `parameters`对象的结构**必须**与所选Action在`## 3. 工具集`中定义的模板**完全一致**。键名、值类型都必须精确匹配。## 3. 工具集 (Available Actions)### CLICK- **功能**: 单击屏幕。- **Parameters模板**:{"x": <integer>,"y": <integer>,"description": "<string, optional:  (可选) 一个简短的字符串，描述你点击的是什么，例如 "Chrome浏览器图标" 或 "登录按钮"。>"}### TYPE- **功能**: 输入文本。- **Parameters模板**:{"text": "<string>","needs_enter": <boolean>}### SCROLL- **功能**: 滚动窗口。- **Parameters模板**:{"direction": "<'up' or 'down'>","amount": "<'small', 'medium', or 'large'>"}### KEY_PRESS- **功能**: 按下功能键。- **Parameters模板**:{"key": "<string: e.g., 'enter', 'esc', 'alt+f4'>"}### FINISH- **功能**: 任务成功完成。- **Parameters模板**:{"message": "<string: 总结任务完成情况>"}### FAILE- **功能**: 任务无法完成。- **Parameters模板**:{"reason": "<string: 清晰解释失败原因>"}## 4. 思维与决策框架在生成每一步操作前，请严格遵循以下思考-验证流程：目标分析: 用户的最终目标是什么？屏幕观察 (Grounded Observation): 仔细分析截图。你的决策必须基于截图中存在的视觉证据。 如果你看不见某个元素，你就不能与它交互。行动决策: 基于目标和可见的元素，选择最合适的工具。构建输出:a. 在thought字段中记录你的思考。b. 选择一个action。c. 精确复制该action的parameters模板，并填充值。最终验证 (Self-Correction): 在输出前，最后检查一遍：我的回复是纯粹的JSON吗？action的值是否正确无误（大写、无空格）？parameters的结构是否与模板100%一致？例如，对于CLICK，是否有独立的x和y键，并且它们的值都是整数？"""
    },
     {
        "role": "user",
        "content": [
            {"image": "https://img.alicdn.com/imgextra/i2/O1CN016iJ8ob1C3xP1s2M6z_!!6000000000026-2-tps-3008-1758.png"},
            {"text": "帮我打开浏览器。"}]
}]

response = dashscope.MultiModalConversation.call(
    # 若没有配置环境变量， 请用百炼API Key将下行替换为： api_key = "sk-xxx"
    api_key = os.getenv('DASHSCOPE_API_KEY'),
    model = 'gui-plus',
    messages = messages
)
print(response.output.choices[0].message.content[0]["text"])
model string （必选）

模型名称。支持的模型：gui-plus。

messages array （必选）

传递给大模型的上下文，按对话顺序排列。

通过HTTP调用时，请将messages 放入 input 对象中。
消息类型

vl_high_resolution_images boolean （可选）默认值为false

是否将输入图像的像素上限提升至 16384 Token 对应的像素值。

vl_high_resolution_images为true，使用固定分辨率策略，像素上限固定为12845056，忽略 max_pixels 设置，超过此分辨率时会将图像总像素缩小至此上限内。

vl_high_resolution_images为false，像素上限由max_pixels决定，输入图像的像素超过max_pixels会将图像缩小至max_pixels内。模型的默认像素上限即max_pixels的默认值。

max_tokens integer （可选）

用于限制模型输出的最大 Token 数。若生成内容超过此值，响应将被截断。

默认值与最大值均为模型的最大输出长度，请参见模型选型。

Java SDK中为maxTokens。通过HTTP调用时，请将 max_tokens 放入 parameters 对象中。
seed integer （可选）

随机数种子。用于确保在相同输入和参数下生成结果可复现。若调用时传入相同的 seed 且其他参数不变，模型将尽可能返回相同结果。

取值范围：[0,231−1]。

通过HTTP调用时，请将 seed 放入 parameters 对象中。
temperature float （可选） 默认值为0.01

采样温度，控制模型生成文本的多样性。

temperature越高，生成的文本更多样，反之，生成的文本更确定。

取值范围： [0, 2)

temperature与top_p均可以控制生成文本的多样性，建议只设置其中一个值。

通过HTTP调用时，请将 temperature 放入 parameters 对象中。
top_p float （可选）默认值为0.01

核采样的概率阈值，控制模型生成文本的多样性。

top_p越高，生成的文本更多样。反之，生成的文本更确定。

取值范围：（0,1.0]

temperature与top_p均可以控制生成文本的多样性，建议只设置其中一个值。

Java SDK中为topP。通过HTTP调用时，请将 top_p 放入 parameters 对象中。
repetition_penalty float （可选）默认值为1.0

模型生成时连续序列中的重复度。提高repetition_penalty时可以降低模型生成的重复度，1.0表示不做惩罚。该参数对模型效果影响较大，建议保持默认值。

Java SDK中为repetitionPenalty。通过HTTP调用时，请将 repetition_penalty 放入 parameters 对象中。
presence_penalty float （可选）

控制模型生成文本时的内容重复度。默认值为1.5

取值范围：[-2.0, 2.0]。正值降低重复度，负值增加重复度。

在创意写作或头脑风暴等需要多样性、趣味性或创造力的场景中，建议调高该值；在技术文档或正式文本等强调一致性与术语准确性的场景中，建议调低该值。

原理介绍

示例

top_k integer （可选）默认值为1

生成过程中采样候选集的大小。例如，取值为50时，仅将单次生成中得分最高的50个Token组成随机采样的候选集。取值越大，生成的随机性越高；取值越小，生成的确定性越高。取值为None或当top_k大于100时，表示不启用top_k策略，此时仅有top_p策略生效。

取值需要大于或等于0。

该参数非OpenAI标准参数。通过 Python SDK调用时，请放入 extra_body 对象中，配置方式为：extra_body={"top_k": xxx}；通过 Node.js SDK 或 HTTP 方式调用时，请作为顶层参数传递。

Java SDK中为topK。通过HTTP调用时，请将 top_k 放入 parameters 对象中。
repetition_penalty float （可选）默认值为1.0

模型生成时连续序列中的重复度。提高repetition_penalty时可以降低模型生成的重复度，1.0表示不做惩罚。该参数对模型效果影响较大，建议保持默认值。

stream boolean （可选）

是否以流式方式输出回复。

可选值：

false：等待模型生成完整回复后一次性返回。

true：模型边生成边返回数据块。客户端需逐块读取，以还原完整回复。

该参数仅支持Python SDK。通过Java SDK实现流式输出请通过streamCall接口调用；通过HTTP实现流式输出请在Header中指定X-DashScope-SSE为enable。
incremental_output boolean （可选）默认为false

在流式输出模式下是否开启增量输出。推荐您优先设置为true。

参数值：

false：每次输出为当前已经生成的整个序列，最后一次输出为生成的完整结果。

 
I
I like
I like apple
I like apple.
true（推荐）：增量输出，即后续输出内容不包含已输出的内容。您需要实时地逐个读取这些片段以获得完整的结果。

 
I
like
apple
.
Java SDK中为incrementalOutput。通过HTTP调用时，请将 incremental_output 放入 parameters 对象中。
stop string 或 array （可选）

用于指定停止词。当模型生成的文本中出现stop 指定的字符串或token_id时，生成将立即终止。

可传入敏感词以控制模型的输出。

stop为数组时，不可将token_id和字符串同时作为元素输入，比如不可以指定为["你好",104307]。
chat响应对象（流式与非流式输出格式一致）
 
{
  "status_code": 200,
  "request_id": "b74b3a25-3968-4059-8c44-63d793c07f02",
  "code": "",
  "message": "",
  "output": {
    "text": null,
    "finish_reason": null,
    "choices": [
      {
        "finish_reason": "stop",
        "message": {
          "role": "assistant",
          "content": [
            {
              "text": "```json\n{\"thought\": \"用户想要打开浏览器，我观察到屏幕截图中有一个Google Chrome的图标，其位置在右上角一排的最后一个。因此，下一步操作应该是点击这个Chrome浏览器图标来启动它。\", \"action\": \"CLICK\", \"parameters\": {\"x\": 1086, \"y\": 127}}\n```"
            }
          ]
        }
      }
    ],
    "audio": null
  },
  "usage": {
    "input_tokens": 2021,
    "output_tokens": 78,
    "characters": 0,
    "image_tokens": 1244,
    "input_tokens_details": {
      "image_tokens": 1244,
      "text_tokens": 777
    },
    "output_tokens_details": {
      "text_tokens": 78
    },
    "total_tokens": 2099
  }
}
status_code string

本次请求的状态码。200 表示请求成功，否则表示请求失败。

Java SDK不会返回该参数。调用失败会抛出异常，异常信息为status_code和message的内容。
request_id string

本次调用的唯一标识符。

Java SDK返回参数为requestId。
code string

错误码，调用成功时为空值。

只有Python SDK返回该参数。
output object

调用结果信息。

属性

text string

该参数当前固定为null。

finish_reason string

模型结束生成的原因。有以下情况：

正在生成时为null；

模型输出自然结束为stop；

因生成长度过长而结束为length；

choices array

模型的输出信息。

属性

audio string

该参数当前固定为null。

usage object

本次请求使用的Token信息。

属性

input_tokens integer

输入 Token 数。

output_tokens integer

输出 Token 数。

image_tokens integer

输入内容包含image时返回该字段。为用户输入图片内容转换成Token后的长度。

characters integer

该参数当前固定为null。

input_tokens_details object

输入 Token 的细粒度分类。

属性

output_tokens_details object

输出 Token 的细粒度分类。

属性

total_tokens integer

消耗的总 Token 数，为input_tokens与output_tokens的总和。

错误码
如果模型调用失败并返回报错信息，请参见错误信息进行解决。