package main

type exitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
}

// udpTarget is deliberately configured on the exit runtime. UDP direct packets
// never carry a destination, so a valid tunnel key cannot be used as an
// arbitrary UDP relay.
type udpTarget struct {
	RuleID     int    `json:"ruleId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

type config struct {
	Role                     string         `json:"role"`
	TunnelID                 int            `json:"tunnelId"`
	RuleID                   int            `json:"ruleId"`
	ListenPort               int            `json:"listenPort"`
	UDPListenPort            int            `json:"udpListenPort,omitempty"`
	Protocol                 string         `json:"protocol"`
	ExitHost                 string         `json:"exitHost"`
	ExitPort                 int            `json:"exitPort"`
	UDPExitPort              int            `json:"udpExitPort,omitempty"`
	Exits                    []exitEndpoint `json:"exits,omitempty"`
	TargetIP                 string         `json:"targetIp"`
	TargetPort               int            `json:"targetPort"`
	UDPTargets               []udpTarget    `json:"udpTargets,omitempty"`
	Key                      string         `json:"key"`
	LimitIn                  int64          `json:"limitIn"`
	LimitOut                 int64          `json:"limitOut"`
	MaxConnections           int            `json:"maxConnections"`
	MaxIPs                   int            `json:"maxIPs"`
	AccessScope              string         `json:"accessScope"`
	BlockHTTP                bool           `json:"blockHttp"`
	BlockSocks               bool           `json:"blockSocks"`
	BlockTLS                 bool           `json:"blockTls"`
	ProxyProtocolReceive     bool           `json:"proxyProtocolReceive"`
	ProxyProtocolSend        bool           `json:"proxyProtocolSend"`
	ProxyProtocolExitReceive bool           `json:"proxyProtocolExitReceive"`
	ProxyProtocolExitSend    bool           `json:"proxyProtocolExitSend"`
	ProxyProtocolVersion     int            `json:"proxyProtocolVersion"`
	TCPFastOpen              bool           `json:"tcpFastOpen"`
	PanelURL                 string         `json:"panelUrl"`
	Token                    string         `json:"token"`
	RelayExitHost            string         `json:"relayExitHost,omitempty"`
	RelayExitPort            int            `json:"relayExitPort,omitempty"`
	UDPRelayExitPort         int            `json:"udpRelayExitPort,omitempty"`
	RelayKey                 string         `json:"relayKey,omitempty"`
	DNSGeneration            int            `json:"dnsGeneration,omitempty"`
}
