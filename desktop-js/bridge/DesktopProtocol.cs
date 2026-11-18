using System;
using System.Collections.Generic;
using System.Text.Json;

namespace TreeExtractor
{
    // 只负责 JSON 行的解析和响应编码，不管理进程、控制台或业务会话。
    internal static class DesktopProtocol
    {
        internal static string ProcessLine(string line, Func<string, Dictionary<string, object>, object> dispatch)
        {
            object id = null;
            try
            {
                using (JsonDocument document = JsonDocument.Parse(line))
                {
                    JsonElement request = document.RootElement;
                    JsonElement requestId, requestMethod, requestParameters;
                    if (request.ValueKind != JsonValueKind.Object ||
                        !request.TryGetProperty("id", out requestId) ||
                        !request.TryGetProperty("method", out requestMethod))
                        throw new ArgumentException("请求缺少 id 或 method。");
                    // 克隆后即使 document 已释放，响应仍能原样带回请求 ID。
                    id = requestId.Clone();
                    string method = requestMethod.ValueKind == JsonValueKind.String
                        ? requestMethod.GetString() : requestMethod.ToString();
                    var parameters = request.TryGetProperty("params", out requestParameters) &&
                        requestParameters.ValueKind == JsonValueKind.Object
                        ? ReadObject(requestParameters) : new Dictionary<string, object>();
                    object result = dispatch(method, parameters);
                    return EncodeReply(id, true, result, null);
                }
            }
            catch (Exception ex)
            {
                while (!(ex is UserFacingException) && ex.InnerException != null) ex = ex.InnerException;
                return EncodeReply(id, false, null, ex.Message);
            }
        }

        // 转为普通 CLR 值后交给业务分发层，保留数字、数组和嵌套对象类型。
        static Dictionary<string, object> ReadObject(JsonElement element)
        {
            var result = new Dictionary<string, object>();
            foreach (JsonProperty property in element.EnumerateObject())
                result[property.Name] = ReadValue(property.Value);
            return result;
        }

        static object ReadValue(JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.String: return element.GetString();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null;
                case JsonValueKind.Number:
                    int integer;
                    if (element.TryGetInt32(out integer)) return integer;
                    long longInteger;
                    if (element.TryGetInt64(out longInteger)) return longInteger;
                    return element.GetDouble();
                case JsonValueKind.Object: return ReadObject(element);
                case JsonValueKind.Array:
                    var items = new List<object>();
                    foreach (JsonElement item in element.EnumerateArray()) items.Add(ReadValue(item));
                    return items;
                default: throw new ArgumentException("不支持的 JSON 参数类型。");
            }
        }

        static string EncodeReply(object id, bool ok, object result, string error)
        {
            return JsonSerializer.Serialize(new Dictionary<string, object> {
                { "id", id }, { "ok", ok }, { "result", result }, { "error", error }
            });
        }
    }
}
