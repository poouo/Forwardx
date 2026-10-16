import assert from "node:assert/strict";
import test from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {NyanpassImportPreview} from "./NyanpassImportPreview";
import {parseCompatibleRuleTransferText} from "../../lib/nyanpassImport";
import {getLanguagePreference,initializeLanguage,setLanguagePreference} from "../../i18n";

test("ny preview shows every target, disabled state and options with translated safe wrapping",async()=>{
  const previous=getLanguagePreference();
  try{
    setLanguagePreference("en");await initializeLanguage();
    const result=parseCompatibleRuleTransferText(JSON.stringify({name:"<script>test</script>",listen_port:1234,dest:["a.example:443","[2001:db8::1]:8443"],dest_policy:"round",proxy_protocol:3,speed_limit:1250000}));
    assert.equal(result.ok,true);
    if(!result.ok)return;
    const html=renderToStaticMarkup(<NyanpassImportPreview rules={result.file.rules}/>);
    assert.match(html,/Disabled after import/);
    assert.match(html,/a.example:443/);
    assert.match(html,/\[2001:db8::1\]:8443/);
    assert.match(html,/round_robin/);
    assert.match(html,/v2/);
    assert.match(html,/10 Mbps/);
    assert.match(html,/&lt;script&gt;/);
    assert.doesNotMatch(html,/<script>/);
    assert.equal(/\p{Script=Han}/u.test(html),false);
  }finally{setLanguagePreference(previous);await initializeLanguage();}
});
