chrome.action.onClicked.addListener(async (tab) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });
  
    const text = result.result;
  
    if (!text) return;
  
    await fetch("http://192.168.29.98:3000/api/generate-doc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt: text })
    });
  
    console.log("Sent to doc");
  });
  