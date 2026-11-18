using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace TreeExtractor
{
    internal static class DesktopProtocolTests
    {
        static int _checks;

        static void Check(bool condition, string message)
        {
            _checks++;
            if (!condition) throw new Exception(message);
        }

        static void SuccessAndParameterTypes()
        {
            const string request = "{\"id\":7,\"method\":\"sample\",\"params\":{" +
                "\"small\":2,\"large\":2147483648,\"decimal\":1.25,\"flag\":true," +
                "\"none\":null,\"array\":[\"item\",{\"nested\":false}]}}";
            string reply = DesktopProtocol.ProcessLine(request, (method, args) => {
                Check(method == "sample", "method");
                Check(args["small"] is int && (int)args["small"] == 2, "int32");
                Check(args["large"] is long && (long)args["large"] == 2147483648L, "int64");
                Check(args["decimal"] is double && (double)args["decimal"] == 1.25, "double");
                Check(args["flag"] is bool && (bool)args["flag"], "bool");
                Check(args["none"] == null, "null");
                var array = (List<object>)args["array"];
                var nested = (Dictionary<string, object>)array[1];
                Check((string)array[0] == "item" && !(bool)nested["nested"], "nested array");
                return new Dictionary<string, object> { { "value", "ok" } };
            });
            using (var json = JsonDocument.Parse(reply))
            {
                var root = json.RootElement;
                Check(root.GetProperty("id").GetInt32() == 7, "success id");
                Check(root.GetProperty("ok").GetBoolean(), "success flag");
                Check(root.GetProperty("result").GetProperty("value").GetString() == "ok", "result");
                Check(root.GetProperty("error").ValueKind == JsonValueKind.Null, "success error");
            }
        }

        static void ErrorsAndFallbacks()
        {
            int dispatches = 0;
            Func<string, Dictionary<string, object>, object> dispatch = (method, args) => {
                dispatches++;
                Check(method == "17" && args.Count == 0, "non-string method and empty params");
                return "ok";
            };
            using (var json = JsonDocument.Parse(DesktopProtocol.ProcessLine("{", dispatch)))
            {
                Check(!json.RootElement.GetProperty("ok").GetBoolean(), "malformed JSON rejected");
                Check(json.RootElement.GetProperty("id").ValueKind == JsonValueKind.Null, "malformed id");
            }
            using (var json = JsonDocument.Parse(DesktopProtocol.ProcessLine("{\"id\":3}", dispatch)))
                Check(!json.RootElement.GetProperty("ok").GetBoolean(), "missing method rejected");
            Check(dispatches == 0, "invalid requests not dispatched");
            using (var json = JsonDocument.Parse(DesktopProtocol.ProcessLine(
                "{\"id\":\"original\",\"method\":17,\"params\":[]}", dispatch)))
            {
                Check(json.RootElement.GetProperty("id").GetString() == "original", "id preserved");
                Check(json.RootElement.GetProperty("ok").GetBoolean(), "non-object params fallback");
            }
            Check(dispatches == 1, "valid request dispatched once");
            string failure = DesktopProtocol.ProcessLine("{\"id\":42,\"method\":\"fail\"}",
                (method, args) => { throw new Exception("outer", new InvalidOperationException("inner")); });
            using (var json = JsonDocument.Parse(failure))
            {
                Check(!json.RootElement.GetProperty("ok").GetBoolean(), "exception response");
                Check(json.RootElement.GetProperty("id").GetInt32() == 42, "exception id");
                Check(json.RootElement.GetProperty("error").GetString() == "inner", "innermost error");
            }
            string contextual = DesktopProtocol.ProcessLine("{\"id\":43,\"method\":\"fail\"}",
                (method, args) => { throw new UserFacingException("校正文件未保存", new IOException("technical detail")); });
            using (var json = JsonDocument.Parse(contextual))
                Check(json.RootElement.GetProperty("error").GetString() == "校正文件未保存", "preserve user-facing context");
            string unsupported = DesktopProtocol.ProcessLine("{\"id\":9,\"method\":\"fail\"}",
                (method, args) => double.NaN);
            using (var json = JsonDocument.Parse(unsupported))
            {
                Check(!json.RootElement.GetProperty("ok").GetBoolean(), "serialization failure response");
                Check(json.RootElement.GetProperty("id").GetInt32() == 9, "serialization failure id");
            }
        }

        internal static int Run()
        {
            _checks = 0;
            SuccessAndParameterTypes();
            ErrorsAndFallbacks();
            Console.WriteLine("DESKTOP PROTOCOL CHECKS=" + _checks + " FAILURES=0");
            return 0;
        }
    }
}
