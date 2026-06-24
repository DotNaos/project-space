package projectvalidator

import yaml "gopkg.in/yaml.v3"

func unmarshalYAML(body []byte, value any) error {
	return yaml.Unmarshal(body, value)
}

func marshalYAML(value any) ([]byte, error) {
	return yaml.Marshal(value)
}
