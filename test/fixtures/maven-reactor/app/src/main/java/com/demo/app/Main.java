package com.demo.app;

import com.demo.lib.Api;
import com.demo.sub.SubApi;

public class Main {
  public String run() {
    return Api.hello() + SubApi.hello();
  }
}
